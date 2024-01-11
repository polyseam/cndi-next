import { ccolors, loadEnv, path } from "deps";

import {
  emitExitEvent,
  getStagingDir,
  getYAMLString,
  loadCndiConfig,
  persistStagedFiles,
  stageFile,
} from "src/utils.ts";

import { loadSealedSecretsKeys } from "src/initialize/sealedSecretsKeys.ts";
import { loadTerraformStatePassphrase } from "src/initialize/terraformStatePassphrase.ts";
import { loadArgoUIAdminPassword } from "src/initialize/argoUIAdminPassword.ts";

import getApplicationManifest from "src/outputs/application-manifest.ts";
import RootChartYaml from "src/outputs/root-chart.ts";
import getSealedSecretManifest from "src/outputs/sealed-secret-manifest.ts";

import getMicrok8sIngressTcpServicesConfigMapManifest from "src/outputs/custom-port-manifests/microk8s/ingress-tcp-services-configmap.ts";
import getMicrok8sIngressDaemonsetManifest from "src/outputs/custom-port-manifests/microk8s/ingress-daemonset.ts";

import getProductionClusterIssuerManifest from "src/outputs/cert-manager-manifests/production-cluster-issuer.ts";
import getDevClusterIssuerManifest from "src/outputs/cert-manager-manifests/self-signed/dev-cluster-issuer.ts";

import getEKSIngressServiceManifestPublic from "../outputs/custom-port-manifests/managed/ingress-service-public.ts";
import getEKSIngressTcpServicesConfigMapManifestPublic from "../outputs/custom-port-manifests/managed/ingress-tcp-services-configmap-public.ts";

import getEKSIngressServiceManifestPrivate from "../outputs/custom-port-manifests/managed/ingress-service-private.ts";
import getEKSIngressTcpServicesConfigMapManifestPrivate from "../outputs/custom-port-manifests/managed/ingress-tcp-services-configmap-private.ts";

import getExternalDNSManifest from "../outputs/core-applications/external-dns.application.yaml.ts";

import stageTerraformResourcesForConfig from "src/outputs/terraform/stageTerraformResourcesForConfig.ts";

import {
  KubernetesManifest,
  KubernetesSecret,
  ManagedNodeKind,
} from "src/types.ts";
import validateConfig from "src/validate/cndiConfig.ts";

const owLabel = ccolors.faded("\nsrc/commands/overwrite.ts:");

interface OverwriteActionArgs {
  output: string;
  file?: string;
  initializing: boolean;
}

export const overwriteAction = async (options: OverwriteActionArgs) => {
  const pathToKubernetesManifests = path.join(
    options.output,
    "cndi",
    "cluster_manifests",
  );

  const pathToTerraformResources = path.join(
    options.output,
    "cndi",
    "terraform",
  );

  const envPath = path.join(options.output, ".env");

  const [config, pathToConfig] = await loadCndiConfig(options?.file);

  if (!options.initializing) {
    console.log(`cndi overwrite --file "${pathToConfig}"\n`);
  } else {
    await loadEnv({ export: true, envPath });
    console.log();
  }

  await validateConfig(config, pathToConfig);

  const sealedSecretsKeys = loadSealedSecretsKeys();
  const terraformStatePassphrase = loadTerraformStatePassphrase();
  const argoUIAdminPassword = loadArgoUIAdminPassword();

  if (!sealedSecretsKeys) {
    console.error(
      owLabel,
      ccolors.key_name(`"SEALED_SECRETS_PUBLIC_KEY"`),
      ccolors.error(`and/or`),
      ccolors.key_name(`"SEALED_SECRETS_PRIVATE_KEY"`),
      ccolors.error(`are not present in environment`),
    );
    await emitExitEvent(501);
    Deno.exit(501);
  }

  if (!argoUIAdminPassword) {
    console.error(
      owLabel,
      ccolors.key_name(`"ARGOCD_ADMIN_PASSWORD"`),
      ccolors.error(`is not set in environment`),
    );
    await emitExitEvent(502);
    Deno.exit(502);
  }

  if (!terraformStatePassphrase) {
    console.error(
      owLabel,
      ccolors.key_name(`"TERRAFORM_STATE_PASSPHRASE"`),
      ccolors.error(`is not set in environment`),
    );
    await emitExitEvent(503);
    Deno.exit(503);
  }

  const cluster_manifests = config?.cluster_manifests || {};

  try {
    // remove all files in cndi/cluster
    await Deno.remove(pathToKubernetesManifests, {
      recursive: true,
    });
  } catch {
    // folder did not exist
  }

  try {
    // remove all files in cndi/terraform
    await Deno.remove(pathToTerraformResources, {
      recursive: true,
    });
  } catch {
    // folder did not exist
  }

  // create temporary key for sealing secrets
  const tempPublicKeyFilePath = await Deno.makeTempFile();

  await Deno.writeTextFile(
    tempPublicKeyFilePath,
    sealedSecretsKeys.sealed_secrets_public_key,
  );

  await stageTerraformResourcesForConfig(config); //, options);
  console.log(ccolors.success("staged terraform stack"));

  const cert_manager = config?.infrastructure?.cndi?.cert_manager;

  if (cert_manager) {
    if (cert_manager?.self_signed) {
      await stageFile(
        path.join(
          "cndi",
          "cluster_manifests",
          "cert-manager-cluster-issuer.yaml",
        ),
        getDevClusterIssuerManifest(),
      );
    } else {
      await stageFile(
        path.join(
          "cndi",
          "cluster_manifests",
          "cert-manager-cluster-issuer.yaml",
        ),
        getProductionClusterIssuerManifest(cert_manager?.email),
      );
    }
  }

  const open_ports = config?.infrastructure?.cndi?.open_ports || [];

  const isMicrok8sCluster = config?.distribution === "microk8s";

  if (
    isMicrok8sCluster
  ) {
    await Promise.all([
      stageFile(
        path.join(
          "cndi",
          "cluster_manifests",
          "ingress-tcp-services-configmap.yaml",
        ),
        getMicrok8sIngressTcpServicesConfigMapManifest(open_ports),
      ),
      stageFile(
        path.join("cndi", "cluster_manifests", "ingress-daemonset.yaml"),
        getMicrok8sIngressDaemonsetManifest(open_ports),
      ),
    ]);
  } else {
    const managedKind = config.distribution as ManagedNodeKind; //aks

    await stageFile(
      path.join("cndi", "cluster_manifests", "ingress-service-private.yaml"),
      getEKSIngressServiceManifestPrivate(open_ports, managedKind),
    );

    await stageFile(
      path.join("cndi", "cluster_manifests", "ingress-service-public.yaml"),
      getEKSIngressServiceManifestPublic(open_ports, managedKind),
    );

    await stageFile(
      path.join(
        "cndi",
        "cluster_manifests",
        "ingress-tcp-services-configmap-public.yaml",
      ),
      getEKSIngressTcpServicesConfigMapManifestPublic(open_ports),
    );

    await stageFile(
      path.join(
        "cndi",
        "cluster_manifests",
        "ingress-tcp-services-configmap-private.yaml",
      ),
      getEKSIngressTcpServicesConfigMapManifestPrivate(open_ports),
    );
  }
  console.log(ccolors.success("staged open ports manifests"));

  await stageFile(
    path.join("cndi", "cluster_manifests", "Chart.yaml"),
    RootChartYaml,
  );

  // write each manifest in the "cluster_manifests" section of the config to `cndi/cluster_manifests`
  for (const key in cluster_manifests) {
    const manifestObj = cluster_manifests[key] as KubernetesManifest;

    if (manifestObj?.kind && manifestObj.kind === "Secret") {
      const secret = cluster_manifests[key] as KubernetesSecret;
      const secretName = `${key}.yaml`;
      const sealedSecretManifest = await getSealedSecretManifest(secret, {
        publicKeyFilePath: tempPublicKeyFilePath,
        envPath,
      });

      if (sealedSecretManifest) {
        await stageFile(
          path.join("cndi", "cluster_manifests", secretName),
          sealedSecretManifest,
        );
        console.log(
          ccolors.success(`staged encrypted secret:`),
          ccolors.key_name(secretName),
        );
      }
      continue;
    }
    const manifestFilename = `${key}.yaml`;
    await stageFile(
      path.join("cndi", "cluster_manifests", manifestFilename),
      getYAMLString(manifestObj),
    );
    console.log(
      ccolors.success("staged manifest:"),
      ccolors.key_name(manifestFilename),
    );
  }

  const { applications } = config;

  // write the `cndi/cluster_manifests/applications/${applicationName}.application.yaml` file for each application
  for (const releaseName in applications) {
    const applicationSpec = applications[releaseName];
    const [manifestContent, filename] = getApplicationManifest(
      releaseName,
      applicationSpec,
    );
    await stageFile(
      path.join("cndi", "cluster_manifests", "applications", filename),
      manifestContent,
    );
    console.log(
      ccolors.success("staged application manifest:"),
      ccolors.key_name(filename),
    );
  }

  const skipExternalDNS =
    config?.infrastructure?.cndi?.external_dns?.enabled === false;

  if (!skipExternalDNS) {
    await stageFile(
      path.join(
        "cndi",
        "cluster_manifests",
        "external-dns.application.yaml",
      ),
      getExternalDNSManifest(config),
    );
    console.log(
      ccolors.success("staged application manifest:"),
      ccolors.key_name("external-dns.application.yaml"),
    );
  }

  try {
    await persistStagedFiles(options.output);
    console.log();
  } catch (errorPersistingStagedFiles) {
    console.error(
      owLabel,
      ccolors.error(`failed to persist staged cndi files to`),
      ccolors.user_input(`${options.output}`),
    );
    console.log(ccolors.caught(errorPersistingStagedFiles));
    await Deno.remove(await getStagingDir(), { recursive: true });
    await emitExitEvent(509);
    Deno.exit(509);
  }

  const completionMessage = options?.initializing
    ? "initialized your cndi project in the ./cndi directory!"
    : "overwrote your cndi project in the ./cndi directory!";

  console.log("\n" + completionMessage);
};
