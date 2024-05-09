import { YAML } from "deps";

// these are somewhat brittle, they are pinned to how checkov outputs empty markdown results
const NO_CHECKOV_FAILURES_EXPRESSION =
  "${{ steps.checkov.outputs.results == '\n\n---' }}";
const CHECKOV_FAILURES_EXPRESSION =
  "${{ steps.checkov.outputs.results != '\n\n---' }}";

const comment_tag = "checkov-failures-comment";

const cndiCheckovSteps = [
  {
    name: "Test with Checkov",
    id: "checkov",
    uses: "bridgecrewio/checkov-action@master",
    "continue-on-error": true,
    with: {
      directory: "./cndi", // run on all cndi artifacts
      output_format: "github_failed_only", // github markdown of failed checks
      output_file_path: "console,checkov", // Save results to ./checkov and print to console
      skip_check: "CKV_SECRET_6", // Skip check for hardcoded secrets by entropy (we encrypt them)
    },
  },
  {
    name: "Comment Checkov Issues",
    if: CHECKOV_FAILURES_EXPRESSION,
    uses: "thollander/actions-comment-pull-request@v2",
    with: {
      mode: "recreate", // recreate the comment if it already exists
      comment_tag,
      message: `## Checkov Failures
          
Checkov found issues in your pull request. Please review and fix them.

\${{ steps.checkov.outputs.results }}`,
    },
  },
  {
    name: "Delete Comment Checkov",
    if: NO_CHECKOV_FAILURES_EXPRESSION,
    uses: "thollander/actions-comment-pull-request@v2",
    with: {
      mode: "delete", // delete the comment if it exists: no errors
      comment_tag,
      message: "Checkov found no issues",
    },
  },
  {
    name: "Print Checkov Results",
    if: NO_CHECKOV_FAILURES_EXPRESSION,
    run: 'echo "Checkov found no issues"', // log to console if no issues
  },
];

const runCndiReleaseSteps = [
  {
    name: "welcome",
    run: 'echo "welcome to cndi!"',
  },
  {
    name: "checkout repo",
    uses: "actions/checkout@v3",
    with: {
      "fetch-depth": 0,
    },
  },
  {
    name: "Setup Python",
    uses: "actions/setup-python@v4",
    with: {
      "python-version": "3.8",
    },
  },
  {
    name: "setup cndi",
    uses: "polyseam/setup-cndi@v2",
  },
  {
    name: "cndi ow",
    env: {
      ARM_REGION: "${{ vars.ARM_REGION }}",
      AWS_REGION: "${{ vars.AWS_REGION }}",
      GIT_USERNAME: "${{ secrets.GIT_USERNAME }}",
      GIT_TOKEN: "${{ secrets.GIT_TOKEN }}",
      GIT_SSH_PRIVATE_KEY: "${{ secrets.GIT_SSH_PRIVATE_KEY }}",
      SSH_PUBLIC_KEY: "${{ secrets.SSH_PUBLIC_KEY }}",
      TERRAFORM_STATE_PASSPHRASE: "${{ secrets.TERRAFORM_STATE_PASSPHRASE }}",
      SEALED_SECRETS_PRIVATE_KEY: "${{ secrets.SEALED_SECRETS_PRIVATE_KEY }}",
      SEALED_SECRETS_PUBLIC_KEY: "${{ secrets.SEALED_SECRETS_PUBLIC_KEY }}",
      ARGOCD_ADMIN_PASSWORD: "${{ secrets.ARGOCD_ADMIN_PASSWORD }}",
      AWS_ACCESS_KEY_ID: "${{ secrets.AWS_ACCESS_KEY_ID }}",
      AWS_SECRET_ACCESS_KEY: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
      GOOGLE_CREDENTIALS: "${{ secrets.GOOGLE_CREDENTIALS }}",
      ARM_SUBSCRIPTION_ID: "${{ secrets.ARM_SUBSCRIPTION_ID }}",
      ARM_TENANT_ID: "${{ secrets.ARM_TENANT_ID }}",
      ARM_CLIENT_ID: "${{ secrets.ARM_CLIENT_ID }}",
      ARM_CLIENT_SECRET: "${{ secrets.ARM_CLIENT_SECRET }}",
      CNDI_TELEMETRY: "${{ secrets.CNDI_TELEMETRY }}",
    },
    run: "cndi ow",
  },
];

function getCndiExecutionSteps(sourceRef?: string) {
  if (!sourceRef) {
    return runCndiReleaseSteps;
  }

  const buildAndRunCndiSteps = [
    {
      name: "welcome",
      run: `echo "welcome to cndi@${sourceRef}!"`,
    },
    {
      name: "checkout cndi repo",
      uses: "actions/checkout@v3",
      with: {
        repository: "polyseam/cndi",
        "fetch-depth": 0,
        ref: sourceRef,
      },
    },
    {
      name: "setup deno",
      uses: "denoland/setup-deno@v1",
    },
    {
      name: "build cndi",
      run: "deno task build-linux",
    },
    {
      name: "persist cndi",
      run: "mkdir -p $HOME/.cndi/bin && mv ./dist/linux/in/* $HOME/.cndi/bin/",
    },
    {
      name: "checkout repo",
      uses: "actions/checkout@v3",
      with: {
        "fetch-depth": 0,
      },
    },
    {
      name: "Setup Python",
      uses: "actions/setup-python@v4",
      with: {
        "python-version": "3.8",
      },
    },
    {
      name: "setup cndi",
      uses: "polyseam/setup-cndi@v2",
    },
    {
      name: "cndi ow",
      env: {
        ARM_REGION: "${{ vars.ARM_REGION }}",
        AWS_REGION: "${{ vars.AWS_REGION }}",
        GIT_USERNAME: "${{ secrets.GIT_USERNAME }}",
        GIT_TOKEN: "${{ secrets.GIT_TOKEN }}",
        GIT_SSH_PRIVATE_KEY: "${{ secrets.GIT_SSH_PRIVATE_KEY }}",
        SSH_PUBLIC_KEY: "${{ secrets.SSH_PUBLIC_KEY }}",
        TERRAFORM_STATE_PASSPHRASE: "${{ secrets.TERRAFORM_STATE_PASSPHRASE }}",
        SEALED_SECRETS_PRIVATE_KEY: "${{ secrets.SEALED_SECRETS_PRIVATE_KEY }}",
        SEALED_SECRETS_PUBLIC_KEY: "${{ secrets.SEALED_SECRETS_PUBLIC_KEY }}",
        ARGOCD_ADMIN_PASSWORD: "${{ secrets.ARGOCD_ADMIN_PASSWORD }}",
        AWS_ACCESS_KEY_ID: "${{ secrets.AWS_ACCESS_KEY_ID }}",
        AWS_SECRET_ACCESS_KEY: "${{ secrets.AWS_SECRET_ACCESS_KEY }}",
        GOOGLE_CREDENTIALS: "${{ secrets.GOOGLE_CREDENTIALS }}",
        ARM_SUBSCRIPTION_ID: "${{ secrets.ARM_SUBSCRIPTION_ID }}",
        ARM_TENANT_ID: "${{ secrets.ARM_TENANT_ID }}",
        ARM_CLIENT_ID: "${{ secrets.ARM_CLIENT_ID }}",
        ARM_CLIENT_SECRET: "${{ secrets.ARM_CLIENT_SECRET }}",
        CNDI_TELEMETRY: "${{ secrets.CNDI_TELEMETRY }}",
      },
      run: "cndi ow",
    },
  ];
  return buildAndRunCndiSteps;
}

const getWorkflowYaml = (sourceRef?: string, disable = false) => {
  const on = disable ? {} : {
    pull_request: {
      types: ["opened", "synchronize", "reopened"],
    },
  };

  const cndiWorkflowObj = {
    name: "cndi",
    on,
    jobs: {
      "cndi-onpull": {
        // TODO: determine min scope
        permissions: "write-all",
        "runs-on": "ubuntu-20.04",
        env: {
          GIT_REPO: "${{ secrets.GIT_REPO }}",
          CNDI_TELEMETRY: "${{ secrets.CNDI_TELEMETRY }}",
        },
        steps: [
          ...getCndiExecutionSteps(sourceRef), // run `cndi ow` because it should pass
          ...cndiCheckovSteps, // run checkov
        ],
      },
    },
  };

  return YAML.stringify(cndiWorkflowObj);
};
export default getWorkflowYaml;
