import { ccolors } from "deps";

import { CNDIPort } from "src/types.ts";
import { getYAMLString } from "src/utils.ts";

const ingressTcpServicesConfigMapManifestLabel = ccolors.faded(
  "\nsrc/outputs/custom-port-manifests/managedk8s/private-ingress-tcp-services-configmap.ts:",
);

interface IngressTCPServicesConfigMap {
  apiVersion: string;
  kind: "ConfigMap";
  metadata: {
    name: "ingress-nginx-private-controller";
    namespace: "ingress-private";
  };
  data: {
    [key: string]: string;
  };
}

const getPrivateIngressTcpServicesConfigMapManifest = (
  ports: Array<CNDIPort>,
): string => {
  const manifest: IngressTCPServicesConfigMap = {
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
      "name": "ingress-nginx-private-controller",
      "namespace": "ingress-private",
    },
    "data": {},
  };

  ports.forEach((port) => {
    if (!port?.number) {
      console.error(
        ingressTcpServicesConfigMapManifestLabel,
        'custom port specs need "number" property',
      );
    }

    if (!port?.namespace && !port?.service) {
      return;
    }

    if (!port?.namespace) {
      console.error(
        ingressTcpServicesConfigMapManifestLabel,
        'custom port specs with "service" need "namespace" property',
      );
    }

    if (!port?.service) {
      console.error(
        ingressTcpServicesConfigMapManifestLabel,
        'custom port specs with "namespace" need "service" property',
      );
    }

    manifest.data[`${port.number}`] =
      `${port.namespace}/${port.service}:${port.number}`;
  });

  return getYAMLString(manifest);
};

export default getPrivateIngressTcpServicesConfigMapManifest;
