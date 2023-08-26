import { ccolors } from "deps";
import { getYAMLString } from "src/utils.ts";

const _devClusterIssuerManifestLabel = ccolors.faded(
  "\nsrc/outputs/self-signed/dev-cluster-issuer.ts:",
);

const getDevClusterIssuerManifest = (): string => {
  const manifest = {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: {
      name: "cluster-issuer",
    },
    spec: {
      selfSigned: {},
    },
  };
  return getYAMLString(manifest);
};

export default getDevClusterIssuerManifest;
