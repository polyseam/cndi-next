import * as path from "https://deno.land/std@0.157.0/path/mod.ts";
import { copy } from "https://deno.land/std@0.157.0/fs/copy.ts";
import { checkInitialized, loadJSONC, getPrettyJSONString } from "../utils.ts";
import { CNDIConfig, CNDIContext, BaseNodeEntrySpec, DeploymentTargetConfiguration } from "../types.ts";
import getApplicationManifest from "../templates/application-manifest.ts";
import getTerraformNodeResource from "../templates/terraform-node-resource.ts";
import getTerraformRootFile from "../templates/terraform-root-file.ts";
import RootChartYaml from "../templates/root-chart.ts";
import getDotEnv from "../templates/env.ts";

import workerBootstrapTerrformTemplate from "../bootstrap/worker_bootstrap_cndi.sh.ts";
import controllerBootstrapTerraformTemplate from "../bootstrap/controller_bootstrap_cndi.sh.ts";

/**
 * COMMAND fn: cndi overwrite-with
 * Overwrites ./cndi directory with the specified config file
 */
const overwriteWithFn = async (context: CNDIContext, initializing = false) => {
  const {
    pathToConfig,
    githubDirectory,
    noGitHub,
    CNDI_SRC,
    projectCndiDirectory,
    pathToNodes,
    noDotEnv,
    dotEnvPath,
  } = context;
  if (!initializing) {
    console.log(`cndi overwrite-with -f "${pathToConfig}"`);
  } else {
    const directoryContainsCNDIFiles = await checkInitialized(context);

    const shouldContinue = directoryContainsCNDIFiles
      ? confirm(
          "It looks like you have already initialized a cndi project in this directory. Overwrite existing artifacts?"
        )
      : true;

    if (!shouldContinue) {
      Deno.exit(0);
    }

    if (!noGitHub) {
      try {
        // overwrite the github workflows and readme, do not clobber other files
        await copy(path.join(CNDI_SRC, "github"), githubDirectory, {
          overwrite: true,
        });
      } catch (githubCopyError) {
        console.log("failed to copy github integration files");
        console.error(githubCopyError);
      }
    }
    if (!noDotEnv) {
      const gitignorePath = path.join(dotEnvPath, "..", ".gitignore");
      try {
        const gitignoreContents = await Deno.readTextFile(gitignorePath);
        if (!gitignoreContents.includes(".env")) {
          await Deno.writeTextFile(
            gitignorePath,
            gitignoreContents + "\n.env\n"
          );
        }
      } catch {
        await Deno.writeTextFile(gitignorePath, "\n.env\n");
      }
      await Deno.writeTextFile(dotEnvPath, getDotEnv());
    }
  }

  const config = (await loadJSONC(pathToConfig)) as unknown as CNDIConfig;

  const cluster = config?.cluster || {};

  try {
    // remove all files in cndi/cluster
    await Deno.remove(path.join(projectCndiDirectory, "cluster"), {
      recursive: true,
    });
  } catch {
    // folder did not exist
  }

  // create 'cndi/' 'cndi/cluster' and 'cndi/cluster/applications'
  await Deno.mkdir(path.join(projectCndiDirectory, "cluster", "applications"), {
    recursive: true,
  });

  // create 'cndi/' 'cndi/terraform' and 'cndi/terraform/nodes'
  await Deno.mkdir(path.join(projectCndiDirectory, "terraform", "nodes"), {
    recursive: true,
  });


  // write tftpl terraform template for the user_data bootstrap script
  await Deno.writeTextFile(path.join(pathToNodes,'worker_bootstrap_cndi.sh.tftpl'), workerBootstrapTerrformTemplate);
  await Deno.writeTextFile(path.join(pathToNodes,'controller_bootstrap_cndi.sh.tftpl'), controllerBootstrapTerraformTemplate);

  // write each manifest in the "cluster" section of the config to `cndi/cluster`
  Object.keys(cluster).forEach(async (key) => {
    await Deno.writeTextFile(
      path.join(projectCndiDirectory, "cluster", `${key}.json`),
      getPrettyJSONString(cluster[key])
    );
  });

  const { nodes } = config;


  // generate setup-cndi.tf.json which depends on which kind of nodes are being deployed
  const terraformRootFile = getTerraformRootFile(nodes)

  // write terraform root file
  await Deno.writeTextFile(path.join(pathToNodes,'setup-cndi.tf.json'), terraformRootFile)

  const { entries } = nodes;
  const deploymentTargetConfiguration = nodes.deploymentTargetConfiguration as DeploymentTargetConfiguration;

  // write terraform nodes files
  entries.forEach((entry: BaseNodeEntrySpec) => {
    const nodeFileContents: string = getTerraformNodeResource(entry, deploymentTargetConfiguration);
    Deno.writeTextFile(
      path.join(pathToNodes, `${entry.name}.cndi-node.tf.json`),
      nodeFileContents, {create: true}
    );
  });

  // write the cndi/cluster/Chart.yaml file
  await Deno.writeTextFile(
    path.join(projectCndiDirectory, "cluster", "Chart.yaml"),
    RootChartYaml
  );

  const { applications } = config;

  // write the `cndi/cluster/applications/${applicationName}.application.json` file for each application
  Object.keys(applications).forEach(async (releaseName) => {
    const applicationSpec = applications[releaseName];
    const [manifestContent, filename] = getApplicationManifest(
      releaseName,
      applicationSpec
    );
    await Deno.writeTextFile(
      path.join(projectCndiDirectory, "cluster", "applications", filename),
      manifestContent,
      { create: true, append: false }
    );
    console.log("created application manifest:", filename);
  });

  const completionMessage = initializing
    ? "initialized your cndi project in the ./cndi directory!"
    : "overwrote your cndi project in the ./cndi directory!";

  console.log(completionMessage);
};

export default overwriteWithFn;
