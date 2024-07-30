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
import { makeAbsolutePath } from "./util/fs.ts";

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

import { unsetValueForKeyPath } from "deps";

type BuiltInValidator = keyof typeof BuiltInValidators;

const templatesLabel = ccolors.faded("\n@cndi/use-template:");

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
): Result<TemplateObject> {
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
): Promise<Result<string>> {
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
        const absPath = makeAbsolutePath(blockIdentifier);
        if (absPath.error) return { error: absPath.error };
        blockIdentifierURL = new URL("file://" + absPath.value);
      } catch {
        return {
          error: new Error(
            [
              templatesLabel,
              "template error:\n",
              ccolors.error("Failed to convert the block filepath to a URL"),
              ccolors.user_input(`"${blockIdentifier}"\n`),
            ].join(" "),
            {
              cause: 1200,
            },
          ),
        };
      }
    } else {
      // Bare Name
      const blockContent = $cndi.blocks.get(blockIdentifier);
      if (!blockContent) {
        if (blockContent === null) {
          return { value: YAML.stringify(null) };
        }
        return {
          error: new Error(
            [
              templatesLabel,
              ccolors.error("Failed to find CNDI Template Block with name:"),
              ccolors.user_input(`"${blockIdentifier}"\n`),
            ].join(" "),
            {
              cause: 1208,
            },
          ),
        };
      } else {
        return { value: YAML.stringify(blockContent) as string };
      }
    }
  }

  let blockBodyResponse = new Response();
  try {
    blockBodyResponse = await fetch(blockIdentifierURL);
  } catch {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error(
            "Failed to fetch CNDI Template Block using URL identifier:",
          ),
          ccolors.user_input(`"${blockIdentifier}"\n`),
        ].join(" "),
        {
          cause: 1201,
        },
      ),
    };
  }

  if (!blockBodyResponse.ok) {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error(
            "Failed to fetch CNDI Template Block using URL identifier:",
          ),
          ccolors.user_input(`"${blockIdentifier}"\n`),
          ccolors.error(`HTTP Status: ${blockBodyResponse.status}`),
        ].join(" "),
        {
          cause: 1201,
        },
      ),
    };
  }

  blockBodyString = await blockBodyResponse.text();

  try {
    YAML.parse(blockBodyString);
  } catch {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error("Failed to parse the CNDI Template Block body as YAML"),
          ccolors.user_input(`"${blockIdentifier}"\n`),
        ].join(" "),
        {
          cause: 1202,
        },
      ),
    };
  }

  return { value: blockBodyString };
}

async function getTemplateBodyStringForIdentifier(
  templateIdentifier: string,
): Promise<Result<string>> {
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
        const absPath = makeAbsolutePath(templateIdentifier);
        if (absPath.error) return { error: absPath.error };
        templateIdentifierURL = new URL("file://" + absPath.value);
      } catch {
        return {
          error: new Error(
            [
              templatesLabel,
              ccolors.error("Failed to convert the template filepath to a URL"),
              ccolors.user_input(`"${templateIdentifier}"\n`),
            ].join(" "),
            {
              cause: 1200,
            },
          ),
        };
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
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error("Failed to fetch CNDI Template using URL identifier:"),
          ccolors.user_input(`"${templateIdentifier}"\n`),
        ].join(" "),
        {
          cause: 1201,
        },
      ),
    };
  }

  if (!templateBodyResponse.ok) {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error("Failed to fetch CNDI Template using URL identifier:"),
          ccolors.user_input(`"${templateIdentifier}"\n`),
          ccolors.error(`HTTP Status: ${templateBodyResponse.status}`),
        ].join(" "),
        {
          cause: 1201,
        },
      ),
    };
  }

  templateBodyString = await templateBodyResponse.text();

  try {
    YAML.parse(templateBodyString);
  } catch {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error("Failed to parse the template body as YAML"),
          ccolors.user_input(`"${templateIdentifier}"\n`),
        ].join(" "),
        {
          cause: 1202,
        },
      ),
    };
  }

  return { value: templateBodyString };
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
            const absPath = makeAbsolutePath(providedPath);
            if (absPath.error) {
              console.log(ccolors.error(absPath.error.message));
              await next(promptDefinition.name);
              return;
            } else {
              try {
                const data = Deno.readTextFileSync(absPath.value!);
                if (data.length) {
                  value = data;
                } else {
                  console.log(ccolors.warn("The file you provided is empty"));
                  await next(promptDefinition.name);
                  return;
                }
              } catch (errReadingFile) {
                console.log(ccolors.warn(errReadingFile.message));
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
                throw new Error(
                  [
                    templatesLabel,
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
) {
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
      return { value: null, condition: body.condition };
    }
  }

  const promptBlockResponse = await getBlockForIdentifier(identifier);

  if (promptBlockResponse.error) {
    return { error: promptBlockResponse.error };
  }

  let importedPromptsText = removeWhitespaceBetweenBraces(
    promptBlockResponse.value,
  );

  importedPromptsText = processBlockBodyArgs(importedPromptsText, body?.args);

  importedPromptsText = literalizeGetPromptResponseCalls(importedPromptsText);

  const importedPromptsArray = YAML.parse(importedPromptsText);

  if (Array.isArray(importedPromptsArray)) {
    return { value: importedPromptsArray };
  } else {
    return { error: new Error("prompt block imports must return YAML Arrays") };
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
): Promise<Result<string>> {
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

  // first loop
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
        return { error: new Error(`No value found for key: ${key}`) };
      }
    }

    let shouldOutput = true;

    if (body?.condition) {
      console.log("condition", body.condition);
      if (!resolveCNDIPromptCondition(body.condition)) {
        shouldOutput = false;
      }
    }

    if (shouldOutput) { // only try to load in a block if the condition is met
      const statement = output.slice(indexOpen, indexClose + 1);
      const identifier = statement.slice(statement.indexOf("(") + 1, -1);
      const obj = await getBlockForIdentifier(identifier);

      if (obj.error) {
        return { error: obj.error };
      }

      obj.value = literalizeGetPromptResponseCalls(
        removeWhitespaceBetweenBraces(unwrapQuotes(obj.value)),
      );

      // get_arg evals
      obj.value = processBlockBodyArgs(obj.value, body?.args);

      setValueForKeyPath(
        cndiConfigObj,
        pathToKey.slice(0, -1),
        YAML.parse(obj.value),
      );
    } else {
      const numChilden =
        Object.keys(getValueFromKeyPath(cndiConfigObj, pathToKey.slice(0, -1)))
          .length;
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

  return { value: output };
}

async function getStringForIdentifier(
  identifier: string,
): Promise<Result<string>> {
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
        const absPath = makeAbsolutePath(identifier);
        if (absPath.error) return { error: absPath.error };
        identifierURL = new URL("file://" + absPath.value);
      } catch {
        return {
          error: new Error(
            [
              templatesLabel,
              "template error:\n",
              ccolors.error("Failed to process $cndi.get_string(") +
              ccolors.user_input(identifier) +
              ccolors.error(")\n"),
              ccolors.error("Unable to convert the string filepath to a URL"),
            ].join(" "),
            {
              cause: 1200,
            },
          ),
        };
      }
    }
  }

  let stringResponse = new Response();
  try {
    stringResponse = await fetch(identifierURL!);
  } catch {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error("Failed to process $cndi.get_string(") +
          ccolors.user_input(identifier) +
          ccolors.error(")\n"),
          ccolors.error("Failed to fetch string using URL identifier"),
        ].join(" "),
        {
          cause: 1201,
        },
      ),
    };
  }

  if (!stringResponse.ok) {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error("Failed to process $cndi.get_string(") +
          ccolors.user_input(identifier) +
          ccolors.error(")\n"),
          ccolors.error("Failed to fetch string using URL identifier"),
          ccolors.error(`HTTP Status: ${stringResponse.status}`),
        ].join(" "),
        {
          cause: 1201,
        },
      ),
    };
  }

  try {
    const str = await stringResponse.text();
    return { value: str };
  } catch {
    return {
      error: new Error(
        [
          templatesLabel,
          ccolors.error("Failed to fetch string for $cndi.get_string(") +
          ccolors.user_input(identifier) +
          ccolors.error(")\n"),
          ccolors.error(`HTTP Status: ${stringResponse.status}`),
        ].join(" "),
        {
          cause: 1201,
        },
      ),
    };
  }
}

async function processCNDIReadmeOutput(
  readmeSpecRaw: Record<string, unknown> = {},
): Promise<Result<string>> {
  const readmeSpecStr = literalizeGetPromptResponseCalls(
    removeWhitespaceBetweenBraces(YAML.stringify(readmeSpecRaw)),
  );

  const readmeSpec = YAML.parse(readmeSpecStr) as Record<string, unknown>;

  const readmeLines: Array<string> = [];
  for (const key in readmeSpec) {
    if (key.startsWith("$cndi.get_block")) {
      console.log("template error:");
      console.log("outputs.readme cannot contain block imports");
      return {
        error: new Error("readme cannot contain block imports"),
      };
    } else if (key.startsWith("$cndi.get_string")) {
      const identifier = key.split("$cndi.get_string(")[1].split(")")[0];
      const strResult = await getStringForIdentifier(identifier);
      if (strResult.error) {
        readmeLines.push(`<!-- ${strResult.error.message} -->`);
      } else {
        readmeLines.push(`${strResult.value}`);
      }
    } else if (key.startsWith("$cndi.comment")) {
      readmeLines.push(`<!-- ${readmeSpec[key]} -->`);
    } else {
      readmeLines.push(`${readmeSpec[key]}`);
    }
  }
  return { value: readmeLines.join("\n\n") };
}

async function processCNDIEnvOutput(envSpecRaw: Record<string, unknown>) {
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
      const obj = await getBlockForIdentifier(identifier);
      if (obj.error) {
        return { error: obj.error };
      }

      // calling literalize on the block as a string results in weird multiline strings in .env
      // so we call the literalize function on each value in the block instead
      // and wrap the result in quotes

      try {
        const block = YAML.parse(obj.value) as Record<string, unknown>;
        for (const blockKey in block) {
          envSpec[blockKey] = `'${
            literalizeGetPromptResponseCalls(`${block[blockKey]}`)
          }'`;
        }
      } catch (error) {
        return {
          error: new Error([
            templatesLabel,
            "template error:\n",
            `template error: every '$cndi.get_block(${identifier})' call in outputs.env must return a flat YAML string`,
            ccolors.caught(error),
          ].join(" ")),
          cause: 1204,
        };
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
  return { value: envLines.join("\n") };
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
): Promise<UseTemplateResult> {
  const { overrides } = options;

  if (options.mode === "webui") {
    throw new Error("webui mode not yet supported");
  }

  for (const property in overrides) {
    $cndi.responses.set(property, overrides[property]);
  }

  const templateBodyStringResult = await getTemplateBodyStringForIdentifier(
    templateIdentifier,
  );

  if (templateBodyStringResult.error) {
    throw templateBodyStringResult.error;
  }

  const coarselyValidatedTemplateBody = getCoarselyValidatedTemplateBody(
    templateBodyStringResult.value,
  );

  if (coarselyValidatedTemplateBody.error) {
    throw coarselyValidatedTemplateBody.error;
  }

  const staticBlocks = coarselyValidatedTemplateBody.value.blocks;

  if (staticBlocks && staticBlocks.length > 0 && Array.isArray(staticBlocks)) {
    for (const block of staticBlocks) {
      $cndi.blocks.set(block.name, block.content);
    }
  }

  // begin asking prompts, including remote imports
  const prompts = (coarselyValidatedTemplateBody.value?.prompts as Array<
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

        const pSpecResult = await fetchPromptBlockForImportStatement(
          evaluatedImportStatement,
          importBlockPSpec[promptBlockImportStatement],
        );

        if (pSpecResult.error) {
          throw pSpecResult.error;
        }

        const importedPromptSpecs = pSpecResult?.value || [];

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
    coarselyValidatedTemplateBody.value.outputs?.cndi_config || {},
  );

  const finalCNDIConfigResult = await processCNDIConfigOutput(
    YAML.parse(cndiConfigYAML) as object,
  );

  if (finalCNDIConfigResult.error) {
    throw finalCNDIConfigResult.error;
  }

  const finalReadmeResult = await processCNDIReadmeOutput(
    coarselyValidatedTemplateBody.value.outputs?.readme || {},
  );

  if (finalReadmeResult.error) {
    throw finalReadmeResult.error;
  }

  const finalEnvResult = await processCNDIEnvOutput(
    coarselyValidatedTemplateBody.value.outputs?.env || {},
  );

  if (finalEnvResult.error) {
    throw finalEnvResult.error;
  }

  const files = {
    "cndi_config.yaml": finalCNDIConfigResult.value,
    "README.md": finalReadmeResult.value,
    ".env": finalEnvResult.value,
  };

  // when stringifying responses, skip undefined values
  const SKIP_UNDEFINED_ENTRIES = true;
  const responses = $cndi.getResponsesAsRecord(SKIP_UNDEFINED_ENTRIES);

  const useTemplateResult: UseTemplateResult = {
    responses,
    files,
  };

  console.log(); // let it breathe

  return useTemplateResult;
}
