import {
  ccolors,
  cprompt,
  getValueFromKeyPath,
  PromptTypes,
  setValueForKeyPath,
  YAML,
} from "deps";

import { BuiltInValidators } from "./util/validation.ts";
import { CNDITemplateComparators } from "./util/conditions.ts";
import { makeAbsolutePath, sanitizeFilePath } from "./util/fs.ts";

import type {
  CNDITemplatePromptResponsePrimitive,
  PromptType,
  Result,
} from "./types.ts";

import { POLYSEAM_TEMPLATE_DIRECTORY_URL } from "consts";

import {
  findPositionOfCNDICallEndToken,
  processBlockBodyArgs,
  removeWhitespaceBetweenBraces,
  unwrapQuotes,
} from "./util/strings.ts";

import { PxResult } from "src/utils.ts";

import { unsetValueForKeyPath } from "deps";

import { ErrOut } from "errout";

type BuiltInValidator = keyof typeof BuiltInValidators;

const label = ccolors.faded("\n@cndi/use-template:");

type CNDIMode = "cli" | "webui";

const ALPHANUMERIC_CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function getRandomString(length = 32, charset = ALPHANUMERIC_CHARSET) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => charset[byte % charset.length]).join("");
}

// TODO: 1200 codes

/**
 * Options for `useTemplate`.
 * - `overrides` is a record of prompt names and their values.
 * - `interactive` is a boolean that determines whether or not to run in interactive mode.
 * - `mode` is a string that determines the mode of execution, currently limited to "cli"
 */
export type UseTemplateOptions = Partial<{
  overrides: Record<string, CNDITemplatePromptResponsePrimitive>;
  interactive: boolean;
  mode: CNDIMode;
}>;

/**
 * This object is the result of a successful call to `useTemplate`.
 * It contains the responses to the prompts and the files generated by the template.
 */
export type UseTemplateResult = {
  responses: Record<string, CNDITemplatePromptResponsePrimitive>;
  files: {
    "README.md": string;
    ".env": string;
    "cndi_config.yaml": string;
    [filename: string]: string;
  };
};

type CNDITemplateConditionTuple = [
  CNDITemplatePromptResponsePrimitive, // input, eg. $cndi.get_prompt_response(foo
  keyof typeof CNDITemplateComparators, // comparator, eg. "=="
  CNDITemplatePromptResponsePrimitive, // standard, eg. "bar"
];

type Block = {
  name: string;
  content: Record<string, unknown>;
};
type GetBlockBody = {
  args?: {
    [key: string]: CNDITemplatePromptResponsePrimitive;
  };
  condition?: CNDITemplateConditionTuple;
};

type CNDITemplateStaticPromptEntry = {
  type: PromptType;
  name: string;
  message: string;
  default?: string | number | boolean | Array<unknown>;
  options?: Array<unknown>;
  validators?: Array<string | Record<string, unknown>>;
  condition: CNDITemplateConditionTuple;
  required?: boolean;
};

type CNDITemplatePromptBlockImportEntry = {
  [importStatement: string]: GetBlockBody;
};

type CNDITemplatePromptEntry =
  | CNDITemplateStaticPromptEntry
  | CNDITemplatePromptBlockImportEntry;

interface TemplateObject {
  blocks: Array<Block>;
  prompts: Array<CNDITemplatePromptEntry>;
  outputs: {
    cndi_config: Record<string, unknown>;
    env: Record<string, unknown>;
    readme: Record<string, unknown>;
    extra_files: Record<string, string>;
  };
}

type CNDIProvider = "aws" | "azure" | "gcp" | "dev";

const distributionMap = {
  aws: "eks",
  azure: "aks",
  gcp: "gke",
  dev: "microk8s",
};

function fixUndefinedDistributionIfRequired(config: string): string {
  const obj = YAML.parse(config) as Record<string, unknown>;
  if (!obj?.distribution || obj.distribution === "undefined") {
    const provider = obj.provider as CNDIProvider;
    obj.distribution = distributionMap[provider] || null;
    $cndi.responses.set(
      "deployment_target_distribution",
      obj.distribution as unknown as CNDITemplatePromptResponsePrimitive,
    );
  }
  return YAML.stringify(obj);
}

const $cndi = {
  responses: new Map<string, CNDITemplatePromptResponsePrimitive>(),
  getResponsesAsRecord: (skipUndefined = false) => {
    const responses: Record<string, CNDITemplatePromptResponsePrimitive> = {};
    $cndi.responses.forEach(
      (val: CNDITemplatePromptResponsePrimitive, key: string) => {
        if (skipUndefined && val === undefined) return;
        responses[key] = val;
      },
    );
    return responses;
  },
  blocks: new Map<string, unknown>(),
};

function getCoarselyValidatedTemplateBody(
  templateBodyString: string,
): PxResult<TemplateObject> {
  if (templateBodyString.indexOf("\n---\n") > -1) {
    return {
      error: new Error(
        "Template body contains multiple YAML documents in a single file.\nUnsupported!",
      ),
    };
  }

  const templateBody = YAML.parse(templateBodyString) as {
    prompts?: unknown;
    blocks?: unknown;
    outputs?: unknown;
  };

  if (typeof templateBody !== "object") {
    return { error: new Error("Template body is not an object") };
  }

  if (templateBody == null) {
    return { error: new Error("Template body is null") };
  }

  if (templateBody?.prompts && !Array.isArray(templateBody.prompts)) {
    return { error: new Error("Template body's prompts is not an array") };
  }

  if (templateBody?.blocks && !Array.isArray(templateBody.blocks)) {
    return { error: new Error("Template body's blocks is not an array") };
  }

  if (!templateBody?.outputs) {
    return { error: new Error(`Template body's "outputs" is not truthy`) };
  }

  return { value: templateBody as TemplateObject };
}

async function getBlockForIdentifier(
  blockIdentifier: string,
): Promise<PxResult<string>> {
  let blockBodyString = ""; // the cndi_template.yaml file contents \as a string
  // Supported Identifier String Types:
  // - URL
  // - Bare Name (arbitrary_manifest -> this.blocks.find(block => block.name === "arbitrary_manifest")
  // - File Path
  let blockIdentifierURL: URL;

  try {
    // URL
    blockIdentifierURL = new URL(blockIdentifier);
  } catch {
    if (blockIdentifier.includes("/")) {
      try {
        const [err, absPath] = makeAbsolutePath(blockIdentifier);
        if (err) return [err];

        blockIdentifierURL = new URL("file://" + absPath);
      } catch {
        return [
          new ErrOut(
            [
              ccolors.error("Failed to convert the block filepath to a URL"),
              ccolors.user_input(`"${blockIdentifier}"\n`),
            ],
            {
              code: 1200,
              label,
              id: "getBlockForIdentifier/!newURL(identifier)",
            },
          ),
        ];
      }
    } else {
      // Bare Name
      const blockContent = $cndi.blocks.get(blockIdentifier);
      if (!blockContent) {
        if (blockContent === null) {
          return [undefined, YAML.stringify(null)];
        }

        return [
          new ErrOut(
            [
              ccolors.error("Failed to find CNDI Template Block with name:"),
              ccolors.user_input(`"${blockIdentifier}"\n`),
            ],
            {
              code: 1208,
              label,
              id: "getBlockForIdentifier/!getBlockByName",
            },
          ),
        ];
      } else {
        return [undefined, YAML.stringify(blockContent)];
      }
    }
  }

  let blockBodyResponse = new Response();
  try {
    blockBodyResponse = await fetch(blockIdentifierURL);
  } catch {
    return [
      new ErrOut(
        [
          ccolors.error(
            "Failed to fetch CNDI Template Block using URL identifier:",
          ),
          ccolors.user_input(`"${blockIdentifier}"\n`),
        ],
        {
          code: 1201,
          label,
          id: "getBlockForIdentifier/!fetch(blockIdentifierURL)",
        },
      ),
    ];
  }

  if (!blockBodyResponse.ok) {
    return [
      new ErrOut(
        [
          ccolors.error(
            "Failed to fetch CNDI Template Block using URL identifier:",
          ),
          ccolors.user_input(`"${blockIdentifier}"\n`),
          ccolors.error(`HTTP Status: ${blockBodyResponse.status}`),
        ],
        {
          code: 1201,
          label,
          id: "getBlockForIdentifier/!blockBodyResponse.ok",
        },
      ),
    ];
  }

  blockBodyString = await blockBodyResponse.text();

  try {
    YAML.parse(blockBodyString);
  } catch {
    return [
      new ErrOut(
        [
          ccolors.error("Failed to parse the CNDI Template Block body as YAML"),
          ccolors.user_input(`"${blockIdentifier}"\n`),
        ],
        {
          code: 1202,
          label,
          id: "getBlockForIdentifier/!YAML.parse(blockBodyString)",
        },
      ),
    ];
  }
  return [undefined, blockBodyString];
}

async function getTemplateBodyStringForIdentifier(
  templateIdentifier: string,
): Promise<PxResult<string>> {
  let templateBodyString = ""; // the cndi_template.yaml file contents \as a string

  // Supported Identifier String Types:
  // - URL
  // - Bare Name (airflow -> https://github.com/polyseam/cndi/main/templates/airflow.yaml)
  // - File Path

  let templateIdentifierURL: URL;

  try {
    // URL
    templateIdentifierURL = new URL(templateIdentifier);
  } catch {
    if (templateIdentifier.includes("/")) {
      try {
        const [err, absPath] = makeAbsolutePath(templateIdentifier);
        if (err) return [err];
        templateIdentifierURL = new URL("file://" + absPath);
      } catch {
        return [
          new ErrOut(
            [
              ccolors.error("Failed to convert the template filepath to a URL"),
              ccolors.user_input(`"${templateIdentifier}"\n`),
            ],
            {
              code: 1200,
              label,
              id:
                "getTemplateBodyStringForIdentifier/!newURL(templateIdentifier)",
            },
          ),
        ];
      }
    } else {
      // Bare Name
      templateIdentifierURL = new URL(
        POLYSEAM_TEMPLATE_DIRECTORY_URL + templateIdentifier + ".yaml",
      );
    }
  }

  let templateBodyResponse = new Response();
  try {
    templateBodyResponse = await fetch(templateIdentifierURL);
  } catch {
    return [
      new ErrOut(
        [
          ccolors.error("Failed to fetch CNDI Template using URL identifier:"),
          ccolors.user_input(`"${templateIdentifier}"\n`),
        ],
        {
          code: 1201,
          label,
          id:
            "getTemplateBodyStringForIdentifier/!fetch(templateIdentifierURL)",
        },
      ),
    ];
  }

  if (!templateBodyResponse.ok) {
    return [
      new ErrOut(
        [
          ccolors.error("Failed to fetch CNDI Template using URL identifier:"),
          ccolors.user_input(`"${templateIdentifier}"\n`),
          ccolors.error(`HTTP Status: ${templateBodyResponse.status}`),
        ],
        {
          code: 1201,
          label,
          id: "getTemplateBodyStringForIdentifier/!templateBodyResponse.ok",
        },
      ),
    ];
  }

  templateBodyString = await templateBodyResponse.text();

  try {
    YAML.parse(templateBodyString);
  } catch {
    return [
      new ErrOut(
        [
          ccolors.error("Failed to parse the CNDI Template body as YAML"),
          ccolors.user_input(`"${templateIdentifier}"\n`),
        ],
        {
          code: 1202,
          label,
          id:
            "getTemplateBodyStringForIdentifier/!YAML.parse(templateBodyString)",
        },
      ),
    ];
  }
  return [undefined, templateBodyString];
}

function resolveCNDIPromptCondition(
  condition: CNDITemplateConditionTuple,
): boolean {
  const [input, comparator, standard] = condition;
  const standardType = typeof standard;

  let val = input;

  if (typeof input === "string") {
    val = literalizeGetPromptResponseCalls(input);

    if (val === undefined) {
      console.log(`value for '${ccolors.user_input(input)}' is undefined`);
      return false;
    }

    if (standardType === "number") {
      val = parseInt(input);
    } else if (standardType === "boolean") {
      val = val === "true" ? true : false;
    }

    const verdict = CNDITemplateComparators[comparator](val, standard);

    return verdict || false;
  } else {
    const verdict = CNDITemplateComparators[comparator](
      val,
      standard as CNDITemplatePromptResponsePrimitive,
    );
    return verdict || false;
  }
}

function literalizeGetRandomStringCalls(input: string): string {
  let output = removeWhitespaceBetweenBraces(input);
  const get_random_string_regexp =
    /\{\{\s*\$cndi\.get_random_string\((\d*)\)\s*\}\}/g;

  output = output.replace(get_random_string_regexp, (_match, len) => {
    const length = parseInt(len) || 32;
    return getRandomString(length);
  });

  return output;
}

async function presentCliffyPrompt(
  promptDefinition: CNDITemplateStaticPromptEntry,
) {
  const type = PromptTypes[promptDefinition.type];
  const message = ccolors.prompt(promptDefinition.message); // add color to prompt message

  // const responses = $cndi.getResponsesAsRecord();

  const shouldShowPrompt = promptDefinition?.condition
    ? resolveCNDIPromptCondition(promptDefinition.condition)
    : true;

  if (!shouldShowPrompt) {
    return;
  }

  if (promptDefinition.default) {
    if (typeof promptDefinition.default === "string") {
      promptDefinition.default = literalizeGetPromptResponseCalls(
        promptDefinition.default,
      );
      promptDefinition.default = literalizeGetRandomStringCalls(
        promptDefinition.default,
      );
    }
  }

  await cprompt([
    {
      ...promptDefinition,
      type,
      message,
      before: async (
        _ownResponses: Record<string, CNDITemplatePromptResponsePrimitive>,
        next: (nextPromptName?: string | true) => Promise<void>,
      ) => {
        // if there is no condition, show the prompt
        if (!promptDefinition?.condition) {
          return await next();
        }

        const shouldShowPrompt = resolveCNDIPromptCondition(
          promptDefinition.condition,
        );

        // if the condition is met, show the prompt
        if (shouldShowPrompt) {
          return await next();
        }
        // the condition was not met, so skip the prompt
        return await next(true);
      },
      after: async (
        responses: Record<string, CNDITemplatePromptResponsePrimitive>,
        next: (nextPromptName?: string | true) => Promise<void>,
      ) => {
        if (
          promptDefinition?.required &&
          !Object.hasOwn(responses, promptDefinition.name)
        ) {
          console.log(ccolors.error("This prompt is required"));
          await next(promptDefinition.name);
          return;
        }

        let value = responses[promptDefinition.name];

        if (promptDefinition.type === "File") {
          const providedPath = responses[promptDefinition.name];

          if (!providedPath) {
            console.log(ccolors.warn("No file path provided"));
            await next(promptDefinition.name);
            return;
          }

          if (providedPath && typeof providedPath === "string") {
            const [err, absPath] = makeAbsolutePath(providedPath);
            if (err) {
              console.log(ccolors.error(err.message));
              await next(promptDefinition.name);
              return;
            } else {
              try {
                const data = Deno.readTextFileSync(absPath);
                if (data.length) {
                  value = data;
                } else {
                  console.log(ccolors.warn("The file you provided is empty"));
                  await next(promptDefinition.name);
                  return;
                }
              } catch (caught) {
                const errReadingFile = caught as Error;
                const msg = errReadingFile?.message ||
                  "Failed to read file at path";
                console.log(ccolors.warn(msg));
                await next(promptDefinition.name);
                return;
              }
            }
          }
        }

        if (value) {
          if (
            promptDefinition.validators?.length &&
            Array.isArray(promptDefinition.validators)
          ) {
            const validity: Array<boolean> = [];
            for (const validatorSpec of promptDefinition.validators) {
              let validatorName;
              let arg;

              if (typeof validatorSpec !== "string") {
                validatorName = Object.keys(validatorSpec)[0];
                arg = validatorSpec[validatorName];
              } else {
                validatorName = validatorSpec;
              }

              const validate =
                BuiltInValidators[validatorName as BuiltInValidator];

              if (typeof validate != "function") {
                // TODO: find alternative to throwing error
                throw new Error(
                  [
                    label,
                    ccolors.error("template error:\n"),
                    ccolors.error("validator"),
                    ccolors.user_input(validatorName),
                    ccolors.error("not found"),
                  ].join(" "),
                  {
                    cause: 1203,
                  },
                );
              } else {
                const validationError = validate({
                  value,
                  type: promptDefinition.type,
                  arg,
                });

                if (validationError) {
                  console.log(ccolors.error(validationError));
                  await next(promptDefinition.name); // validation failed, run same prompt again
                  return;
                } else {
                  validity.push(true);
                  if (validity.length === promptDefinition.validators.length) {
                    // all validations for prompt passed, proceed to next prompt
                    $cndi.responses.set(promptDefinition.name, value);
                    await next();
                    return;
                  }
                  continue;
                }
              }
            }
          }
        }
        $cndi.responses.set(promptDefinition.name, value);
      },
    },
    // deno-lint-ignore no-explicit-any
  ] as any);
}

async function fetchPromptBlockForImportStatement(
  importStatement: string,
  body: GetBlockBody,
): Promise<PxResult<Array<unknown>>> {
  const literalizedImportStatement = literalizeGetPromptResponseCalls(
    removeWhitespaceBetweenBraces(importStatement),
  );

  const identifier = literalizeGetPromptResponseCalls(
    literalizedImportStatement.slice(
      literalizedImportStatement.indexOf("(") + 1,
      literalizedImportStatement.lastIndexOf(")"),
    ),
  );

  if (body?.condition) {
    if (!resolveCNDIPromptCondition(body.condition)) {
      return [undefined, []];
    }
  }

  const [errGettingBlock, promptBlockResponse] = await getBlockForIdentifier(
    identifier,
  );

  if (errGettingBlock) return [errGettingBlock];

  let importedPromptsText = removeWhitespaceBetweenBraces(promptBlockResponse);

  importedPromptsText = processBlockBodyArgs(importedPromptsText, body?.args);

  importedPromptsText = literalizeGetPromptResponseCalls(importedPromptsText);

  const importedPromptsArray = YAML.parse(importedPromptsText);

  if (Array.isArray(importedPromptsArray)) {
    return [undefined, importedPromptsArray];
  } else {
    return [
      new ErrOut(
        [ccolors.error("Prompt block imports must return YAML Arrays")],
        {
          label,
          code: 1299,
          id:
            "fetchPromptBlockForImportStatement/!Array.isArray(importedPromptsArray)",
        },
      ),
    ];
  }
}

function processCNDICommentCalls(input: string): string {
  // Update the regular expression to match $cndi.comment(anyString):
  // This regex captures any string inside the parentheses and any text following the pattern
  // excluding wrapping quotes until the end of the line

  // excluding quotes
  const pattern = /\$cndi\.comment\(([^)]+)\):\s*(?:"|')?(.*?)(?:"|')?\s*$/gm;

  // Replace the matched lines with '# ' followed by the captured text after the colon
  const replaced = input.replace(pattern, "# $2");

  return replaced;
}

function literalizeGetPromptResponseCalls(input: string): string {
  const responses = $cndi.getResponsesAsRecord();
  let output = removeWhitespaceBetweenBraces(input);
  for (const responseKey in responses) {
    const val = responses[responseKey];

    if (typeof val == "string") {
      output = output.replaceAll(
        `{{$cndi.get_prompt_response(${responseKey})}}`,
        `${val}`,
      );
    } else {
      // replace the macro and remove surrrounding single quotes when it represents the entire value
      output = output.replaceAll(
        `'{{$cndi.get_prompt_response(${responseKey})}}'`,
        `${val}`,
      );
      // replace the macro when it is embedded in a string
      output = output.replaceAll(
        `{{$cndi.get_prompt_response(${responseKey})}}`,
        `${val}`,
      );
    }
  }
  return output;
}

type PathSegment = string | number; // Path segments can be string (for object keys) or number (for array indices)

function findPathToKey(
  key: string,
  obj: object | Array<unknown>,
  path: PathSegment[] = [],
): PathSegment[] {
  // Check if obj is an object or array, if not return an empty array (base case for recursion)
  if (obj === null || typeof obj !== "object") {
    return [];
  }

  // Iterate over keys of the object or array
  for (const [currentKey, value] of Object.entries(obj)) {
    // If the current key is the key we're looking for, return the path
    if (currentKey === key) {
      return path.concat(currentKey);
    }

    // If the value is an object or array, recursively search this sub-object
    const result = findPathToKey(key, value, path.concat(currentKey));

    // If the recursive call found the key, return the result
    if (result.length) {
      return result;
    }
  }

  // If the key was not found in the object or any sub-objects, return an empty array
  return [];
}

async function processCNDIConfigOutput(
  cndi_config: object,
): Promise<PxResult<string>> {
  let cndiConfigObj = cndi_config; // object is mutated

  let output = removeWhitespaceBetweenBraces(YAML.stringify(cndiConfigObj));

  // get_prompt_response evals
  output = literalizeGetPromptResponseCalls(output);

  // get_random_string evals
  output = literalizeGetRandomStringCalls(output);

  // get_block evals
  const getBlockBeginToken = "$cndi.get_block(";
  const getBlockEndToken = ")':"; // depends on serialization wrapping key in ' quotes
  const getBlockEndTokenNoQuote = "):\n"; // fallback if key is not wrapped in quotes

  let indexOpen = output.indexOf(getBlockBeginToken);
  let indexClose = output.indexOf(getBlockEndToken, indexOpen);

  // possible that noQuote signature is in first loop: set constent for while condition
  const noQuoteIndexClose = output.indexOf(getBlockEndTokenNoQuote, indexOpen);

  let ax = 0;

  // while there are $cndi.get_block calls to process
  while (indexOpen > -1 && (indexClose > -1 || noQuoteIndexClose > -1)) {
    cndiConfigObj = YAML.parse(output) as object;

    let key = output.slice(indexOpen, indexClose + 1); // get_block key which contains body
    let pathToKey = findPathToKey(key, cndiConfigObj); // path to first instance of key

    // load value of key
    let body = getValueFromKeyPath(cndiConfigObj, pathToKey) as GetBlockBody;

    if (!body) {
      // if call signature is not '$cndi.get_block(foo)':
      // and is instead $cndi.get_block(foo):\n
      indexClose = output.indexOf(getBlockEndTokenNoQuote, indexOpen);
      key = output.slice(indexOpen, indexClose + 1);
      pathToKey = findPathToKey(key, cndiConfigObj);
      body = getValueFromKeyPath(cndiConfigObj, pathToKey) as GetBlockBody;
      if (!body) {
        return [
          new ErrOut(
            [
              ccolors.error("Failed to find block with key:"),
              ccolors.user_input(key),
            ],
            {
              label,
              code: 1204,
              id: "processCNDIConfigOutput/!body",
            },
          ),
        ];
      }
    }

    let shouldOutput = true;

    if (body?.condition) {
      if (!resolveCNDIPromptCondition(body.condition)) {
        shouldOutput = false;
      }
    }

    if (shouldOutput) {
      // only try to load in a block if the condition is met
      const statement = output.slice(indexOpen, indexClose + 1);
      const identifier = statement.slice(statement.indexOf("(") + 1, -1);
      let [errGettingBlock, blockString] = await getBlockForIdentifier(
        identifier,
      );

      if (errGettingBlock) return [errGettingBlock];

      blockString = literalizeGetPromptResponseCalls(
        removeWhitespaceBetweenBraces(unwrapQuotes(blockString!)),
      );

      // get_arg evals
      blockString = processBlockBodyArgs(blockString, body?.args);

      setValueForKeyPath(
        cndiConfigObj,
        pathToKey.slice(0, -1),
        YAML.parse(blockString),
      );
    } else {
      const numChilden = Object.keys(
        getValueFromKeyPath(cndiConfigObj, pathToKey.slice(0, -1)),
      ).length;
      if (numChilden === 1) {
        unsetValueForKeyPath(cndiConfigObj, pathToKey.slice(0, -1));
      } else {
        unsetValueForKeyPath(cndiConfigObj, pathToKey);
      }
    }

    output = YAML.stringify(cndiConfigObj);
    indexOpen = output.indexOf(getBlockBeginToken);
    indexClose = findPositionOfCNDICallEndToken(output, indexOpen) || -1;
    ax++;
  }

  // get_prompt_response evals (again)
  output = literalizeGetPromptResponseCalls(output);
  output = processCNDICommentCalls(output);
  output = fixUndefinedDistributionIfRequired(output);

  return [undefined, output];
}

async function getStringForIdentifier(
  identifier: string,
): Promise<PxResult<string>> {
  // Supported Identifier String Types:
  // - URL
  // - File Path
  let identifierURL: URL;

  try {
    // URL
    identifierURL = new URL(identifier);
  } catch {
    if (identifier.includes("/")) {
      try {
        const [err, absPath] = makeAbsolutePath(identifier);
        if (err) return [err];

        identifierURL = new URL("file://" + absPath);
      } catch {
        return [
          new ErrOut(
            [
              ccolors.error("Failed to convert the string filepath to a URL"),
              ccolors.user_input(`"${identifier}"\n`),
            ],
            {
              code: 1200,
              label,
              id: "getStringForIdentifier/!newURL(identifier)",
            },
          ),
        ];
      }
    }
  }

  let stringResponse = new Response();
  try {
    stringResponse = await fetch(identifierURL!);
  } catch {
    return [
      new ErrOut(
        [
          ccolors.error("Failed to fetch string using URL identifier:"),
          ccolors.user_input(`"${identifier}"\n`),
        ],
        {
          code: 1201,
          label,
          id: "getStringForIdentifier/!fetch(identifierURL)",
        },
      ),
    ];
  }

  if (!stringResponse.ok) {
    return [
      new ErrOut(
        [
          ccolors.error("Failed to fetch string using URL identifier:"),
          ccolors.user_input(`"${identifier}"\n`),
          ccolors.error(`HTTP Status: ${stringResponse.status}`),
        ],
        {
          code: 1201,
          label,
          id: "getStringForIdentifier/!stringResponse.ok",
        },
      ),
    ];
  }

  try {
    const str = await stringResponse.text();
    return [undefined, str];
  } catch {
    return [
      new ErrOut(
        [
          ccolors.error(
            `Failed to fetch string for $cndi.get_string(${
              ccolors.user_input(
                identifier,
              )
            })\n`,
          ),
          ccolors.error(`HTTP Status: ${stringResponse.status}`),
        ],
        {
          code: 1201,
          label,
          id: "getStringForIdentifier/!stringResponse.text",
        },
      ),
    ];
  }
}

async function processCNDIReadmeOutput(
  readmeSpecRaw: Record<string, unknown> = {},
): Promise<PxResult<string>> {
  const readmeSpecStr = literalizeGetPromptResponseCalls(
    removeWhitespaceBetweenBraces(YAML.stringify(readmeSpecRaw)),
  );

  const readmeSpec = YAML.parse(readmeSpecStr) as Record<string, unknown>;

  const readmeLines: Array<string> = [];
  for (const key in readmeSpec) {
    if (key.startsWith("$cndi.get_block")) {
      console.log("template error:");
      console.log("outputs.readme cannot contain block imports");
      return [
        new ErrOut(
          [
            ccolors.error("template error:"),
            ccolors.key_name("outputs.readme"),
            ccolors.error("cannot contain block imports"),
          ],
          {
            code: 1204,
            label,
            id: "processCNDIReadmeOutput/!key.startsWith($cndi.get_block)",
          },
        ),
      ];
    } else if (key.startsWith("$cndi.get_string")) {
      const identifier = key.split("$cndi.get_string(")[1].split(")")[0];
      const [errGettingStr, strResult] = await getStringForIdentifier(
        identifier,
      );
      if (errGettingStr) {
        readmeLines.push(`<!-- ${errGettingStr.message} -->`);
      } else {
        readmeLines.push(`${strResult}`);
      }
    } else if (key.startsWith("$cndi.comment")) {
      readmeLines.push(`<!-- ${readmeSpec[key]} -->`);
    } else {
      readmeLines.push(`${readmeSpec[key]}`);
    }
  }
  return [undefined, readmeLines.join("\n\n")];
}

async function processCNDIEnvOutput(
  envSpecRaw: Record<string, unknown>,
): Promise<PxResult<string>> {
  const envStr = YAML.stringify(envSpecRaw);
  const envSpec = YAML.parse(
    literalizeGetPromptResponseCalls(envStr),
  ) as Record<string, unknown>;
  const envLines: Array<string> = [];

  for (const key in envSpec) {
    if (key.startsWith("$cndi.get_block")) {
      const body = envSpec[key] as GetBlockBody;

      if (body?.condition) {
        if (!resolveCNDIPromptCondition(body.condition)) {
          continue; // skip adding an entry if it's condition is present and unmet
        }
      }

      const identifier = key.split("$cndi.get_block(")[1].split(")")[0];
      const [errorGettingBlock, blockStr] = await getBlockForIdentifier(
        identifier,
      );

      if (errorGettingBlock) return [errorGettingBlock];

      // calling literalize on the block as a string results in weird multiline strings in .env
      // so we call the literalize function on each value in the block instead
      // and wrap the result in quotes

      try {
        const block = YAML.parse(blockStr) as Record<string, unknown>;
        for (const blockKey in block) {
          envSpec[blockKey] = `'${
            literalizeGetPromptResponseCalls(
              `${block[blockKey]}`,
            )
          }'`;
        }
      } catch (_parseError) {
        return [
          new ErrOut(
            [
              ccolors.error("template error:\n"),
              ccolors.error(
                `template error: every '$cndi.get_block(${identifier})' call in outputs.env must return a flat YAML string`,
              ),
            ],
            {
              code: 1204,
              label,
              id: "processCNDIEnvOutput/!isFlatYAML(blockStr)",
            },
          ),
        ];
      }
    }
  }

  for (const key in envSpec) {
    let val = literalizeGetPromptResponseCalls(`${envSpec[key]}`);
    val = literalizeGetRandomStringCalls(val);
    if (key.startsWith("$cndi.comment")) {
      envLines.push(`\n# ${unwrapQuotes(val)}`);
    } else if (key.startsWith("$cndi.get_block")) {
      // do nothing, already handled
    } else if (val === "" || val === "''") {
      const placeholder = `__${key}_PLACEHOLDER__`;
      envLines.push(`${key}=${placeholder}`);
    } else {
      envLines.push(`${key}=${val}`);
    }
  }
  return [undefined, envLines.join("\n")];
}

type ExtraFiles = Record<string, string>;

async function processCNDIExtraFilesOutput(
  extraFilesSpec: Record<string, string>,
): Promise<PxResult<ExtraFiles>> {
  const extra_files: Record<string, string> = {};
  for (let key in extraFilesSpec) {
    if (!key.startsWith("./")) {
      return [
        new ErrOut(
          [
            ccolors.error(
              `extra_files keys must start with './', got: ${key}`,
            ),
          ],
          {
            label,
            code: 1205,
            id: "processCNDIExtraFilesOutput/!key.startsWith(./)",
          },
        ),
      ];
    }

    const [errorSantizing, sanitizedKey] = sanitizeFilePath(key);

    if (errorSantizing) return [errorSantizing];

    const content = `${extraFilesSpec[key]}`;
    key = sanitizedKey;
    if (URL.canParse(content)) {
      const response = await fetch(content);
      if (response.ok) {
        extra_files[key] = await response.text();
      } else {
        return [
          new ErrOut(
            [
              ccolors.error(
                `Failed to fetch extra_files content for ${key}`,
              ),
            ],
            {
              label,
              code: 1206,
              id: "processCNDIExtraFilesOutput/!response.ok",
            },
          ),
        ];
      }
    } else {
      extra_files[key] = content;
    }
  }
  return [undefined, extra_files];
}

/**
 * Process a CNDI Template and return the results.
 * @param templateIdentifier Identifier that points to your Template, it can be a URL, a file path, or a name
 * @param options object containing overrides and whether or not to run in interactive mode
 * @returns A Promise that resolves to an object containing the final prompt responses and files
 */

export async function useTemplate(
  templateIdentifier: string,
  options: UseTemplateOptions,
): Promise<PxResult<UseTemplateResult>> {
  const { overrides } = options;

  if (options.mode === "webui") {
    return [
      new ErrOut([ccolors.error("webui mode not yet supported")], {
        label,
        code: 1299,
        id: "useTemplate/options.mode===webui",
      }),
    ];
  }

  for (const property in overrides) {
    $cndi.responses.set(property, overrides[property]);
  }

  const [errorGettingTemplateBodyString, templateBodyString] =
    await getTemplateBodyStringForIdentifier(
      templateIdentifier,
    );

  if (errorGettingTemplateBodyString) return [errorGettingTemplateBodyString];

  const [templateBodyCoarseValidationErr, coarselyValidatedTemplateBody] =
    getCoarselyValidatedTemplateBody(
      templateBodyString,
    );

  if (templateBodyCoarseValidationErr) return [templateBodyCoarseValidationErr];

  const staticBlocks = coarselyValidatedTemplateBody.blocks;

  if (staticBlocks && staticBlocks.length > 0 && Array.isArray(staticBlocks)) {
    for (const block of staticBlocks) {
      $cndi.blocks.set(block.name, block.content);
    }
  }

  // begin asking prompts, including remote imports
  const prompts = (coarselyValidatedTemplateBody.prompts as Array<
    CNDITemplatePromptEntry | CNDITemplatePromptBlockImportEntry
  >) || [];

  for (const pSpec of prompts) {
    if (pSpec?.name && $cndi.responses.has(`${pSpec.name}`)) {
      // prompt response already provided
      continue;
    } else {
      const promptIsImportStatement = Object.keys(pSpec).length === 1;

      if (promptIsImportStatement) {
        // formerly !>1
        // this is a prompt import
        const importBlockPSpec = pSpec as CNDITemplatePromptBlockImportEntry;
        const promptBlockImportStatement = Object.keys(importBlockPSpec)[0];

        const evaluatedImportStatement = literalizeGetPromptResponseCalls(
          promptBlockImportStatement,
        );

        const [errorFetchingPrompts, pSpecImported] =
          await fetchPromptBlockForImportStatement(
            evaluatedImportStatement,
            importBlockPSpec[promptBlockImportStatement],
          );

        if (errorFetchingPrompts) return [errorFetchingPrompts];

        const importedPromptSpecs = pSpecImported;

        for (const prompt of importedPromptSpecs) {
          // imported prompt may be defined, if so skip
          if (!$cndi.responses.has(prompt.name)) {
            if (options.interactive) {
              await presentCliffyPrompt(
                prompt as CNDITemplateStaticPromptEntry,
              );
            } else {
              $cndi.responses.set(prompt.name, prompt.default);
            }
          }
        }
      } else {
        // this is a prompt literal
        const staticPSpec = pSpec as CNDITemplateStaticPromptEntry;
        if (options.interactive) {
          await presentCliffyPrompt(staticPSpec);
        } else {
          $cndi.responses.set(
            staticPSpec.name,
            staticPSpec.default as CNDITemplatePromptResponsePrimitive,
          );
        }
      }
    }
  }
  // end asking prompts, all responses should be populated

  // begin processing outputs, starting with cndi_config

  const cndiConfigYAML = YAML.stringify(
    coarselyValidatedTemplateBody.outputs?.cndi_config || {},
  );

  const [errorProcessingCNDIConfigOutput, finalCNDIConfig] =
    await processCNDIConfigOutput(
      YAML.parse(cndiConfigYAML) as object,
    );

  if (errorProcessingCNDIConfigOutput) return [errorProcessingCNDIConfigOutput];

  const [errorProcessingCNDIReadmeOutput, finalReadme] =
    await processCNDIReadmeOutput(
      coarselyValidatedTemplateBody.outputs?.readme || {},
    );

  if (errorProcessingCNDIReadmeOutput) return [errorProcessingCNDIReadmeOutput];

  const [errorProcessingCNDIEnvOutput, finalEnv] = await processCNDIEnvOutput(
    coarselyValidatedTemplateBody.outputs?.env || {},
  );

  if (errorProcessingCNDIEnvOutput) return [errorProcessingCNDIEnvOutput];

  const [errorProcessingExtraFilesOutput, extraFiles] =
    await processCNDIExtraFilesOutput(
      coarselyValidatedTemplateBody.outputs?.extra_files || {},
    );

  if (errorProcessingExtraFilesOutput) return [errorProcessingExtraFilesOutput];

  const files = {
    "cndi_config.yaml": finalCNDIConfig,
    "README.md": finalReadme,
    ".env": finalEnv,
    ...extraFiles,
  };

  // when stringifying responses, skip undefined values
  const SKIP_UNDEFINED_ENTRIES = true;
  const responses = $cndi.getResponsesAsRecord(SKIP_UNDEFINED_ENTRIES);

  const useTemplateResult: UseTemplateResult = {
    responses,
    files,
  };

  console.log(); // let it breathe

  return [undefined, useTemplateResult];
}
