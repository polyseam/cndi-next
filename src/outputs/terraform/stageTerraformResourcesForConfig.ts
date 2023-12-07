import { path } from "deps";
import { CNDIConfig } from "src/types.ts";
import {
  patchAndStageTerraformFilesWithConfig,
  stageFile,
  useSshRepoAuth,
} from "src/utils.ts";
import { stageTerraformSynthAWSMicrok8s } from "src/outputs/terraform/aws/AWSMicrok8sStack.ts";
import { stageTerraformSynthAWSEKS } from "src/outputs/terraform/aws/AWSEKSStack.ts";
import { stageTerraformSynthAzureMicrok8s } from "src/outputs/terraform/azure/AzureMicrok8sStack.ts";
import { stageTerraformSynthAzureAKS } from "src/outputs/terraform/azure/AzureAKSStack.ts";
import { stageTerraformSynthGCPMicrok8s } from "src/outputs/terraform/gcp/GCPMicrok8sStack.ts";
import { stageTerraformSynthGCPGKE } from "src/outputs/terraform/gcp/GCPGKEStack.ts";
// import stageTerraformResourcesForAzure from "src/outputs/terraform/azure/stageAll.ts";
// import stageTerraformResourcesForAzureAKS from "src/outputs/terraform/azure-aks/stageAll.ts";
import stageTerraformResourcesForDev from "src/outputs/terraform/dev/stageAll.ts";
// import stageTerraformResourcesForGCPGKE from "src/outputs/terraform/gcp-gke/stageAll.ts";
// import cndi_join_token from "src/outputs/terraform/shared/cndi_join_token.tf.json.ts";
// import global_variable from "src/outputs/terraform/shared/global.variable.tf.json.ts";
// import global_locals from "src/outputs/terraform/shared/global.locals.tf.json.ts";

import microk8sCloudInitLeaderTerraformTemplate from "src/cloud-init/microk8s/leader.yml.ts";
import microk8sCloudInitFollowerTerraformTemplate from "src/cloud-init/microk8s/follower.yml.ts";

export default async function stageTerraformResourcesForConfig(
  config: CNDIConfig,
  // options: { output: string; initializing: boolean },
) {
  const { distribution, provider } = config;

  const label = `${provider}/${distribution}`;

  switch (label) {
    case "aws/microk8s":
      await stageTerraformSynthAWSMicrok8s(config);
      break;
    case "aws/eks":
      await stageTerraformSynthAWSEKS(config);
      break;
    case "gcp/gke":
      await stageTerraformSynthGCPGKE(config);
      break;
    case "gcp/microk8s":
      await stageTerraformSynthGCPMicrok8s(config);
      break;
    case "azure/microk8s":
      await stageTerraformSynthAzureMicrok8s(config);
      break;
    case "azure/aks":
      await stageTerraformSynthAzureAKS(config);
      break;
    case "dev/microk8s":
      await stageTerraformResourcesForDev(config);
      break;
    default:
      throw new Error(`Unknown label: ${label}`);
  }

  await Promise.all([
    // // add global variables
    // stageFile(
    //   path.join("cndi", "terraform", "global.variable.tf.json"),
    //   global_variable(),
    // ),
    // // add global locals
    // stageFile(
    //   path.join("cndi", "terraform", "global.locals.tf.json"),
    //   global_locals({
    //     cndi_project_name,
    //   }),
    // ),
    // // write the microk8s join token generator
    // stageFile(
    //   path.join("cndi", "terraform", "cndi_join_token.tf.json"),
    //   cndi_join_token(),
    // ),

    // write tftpl terraform template for the user_data bootstrap script
    stageFile(
      path.join("cndi", "terraform", "microk8s-cloud-init-leader.yml.tftpl"),
      microk8sCloudInitLeaderTerraformTemplate(config, {
        useSshRepoAuth: useSshRepoAuth(),
        useClusterHA: config.infrastructure.cndi.nodes.length > 2,
      }),
    ),
    // this file may be extra
    stageFile(
      path.join(
        "cndi",
        "terraform",
        "microk8s-cloud-init-controller.yml.tftpl",
      ),
      microk8sCloudInitFollowerTerraformTemplate(config),
    ),
    // this file may be extra
    stageFile(
      path.join("cndi", "terraform", "microk8s-cloud-init-worker.yml.tftpl"),
      microk8sCloudInitFollowerTerraformTemplate(config, { isWorker: true }),
    ),
  ]);
  await patchAndStageTerraformFilesWithConfig(config);
}
