import { getPrettyJSONString, getTFResource } from "src/utils.ts";

export default function getSealedSecretsTFJSON(): string {
  const resource = getTFResource("helm_release", {
    chart: "sealed-secrets",
    depends_on: [
      "module.cndi_gke_cluster",
      "kubectl_manifest.cndi_sealed_secrets_secret_manifest",
    ],
    name: "sealed-secrets",
    namespace: "kube-system",
    repository: "https://bitnami-labs.github.io/sealed-secrets",
    version: "2.7.0",
  }, "cndi_sealed_secrets_helm_chart");
  return getPrettyJSONString(resource);
}
