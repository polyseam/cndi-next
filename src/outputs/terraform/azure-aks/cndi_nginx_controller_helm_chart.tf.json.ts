import { getPrettyJSONString, getTFResource } from "src/utils.ts";

export default function getNginxControllerTFJSON(): string {
  const resource = getTFResource("helm_release", {
    chart: "ingress-nginx",
    create_namespace: true,
    depends_on: [
      "module.cndi_aks_cluster",
    ],
    name: "ingress-nginx",
    namespace: "ingress",
    repository: "https://kubernetes.github.io/ingress-nginx",
    timeout: "300",
    atomic: true,
    set: [
      {
        "name":
          "controller.service.annotations.service\\.beta\\.kubernetes\\.io/azure-load-balancer-health-probe-request-path",
        "value": "/healthz",
      },
      {
        "name": "controller.service.enabled",
        "value": "true",
      },
      {
        "name":
          "controller.admissionWebhooks.nodeSelector\\.kubernetes\\.io/os",
        "value": "linux",
      },
      {
        "name":
          "controller.admissionWebhooks.patch.nodeSelector\\.kubernetes\\.io/os",
        "value": "linux",
      },
      {
        "name": "defaultBackend.nodeSelector\\.beta\\.kubernetes\\.io/os",
        "value": "linux",
      },
      {
        "name": "controller.ingressClassResource.default",
        "value": "true",
      },
      {
        "name": "controller.ingressClassResource.enabled",
        "value": "true",
      },
      {
        "name": "controller.ingressClassResource.name",
        "value": "public",
      },
      {
        "name": "controller.ingressClass",
        "value": "public",
      },
      {
        "name": "controller.extraArgs.tcp-services-configmap",
        "value": "ingress/ingress-nginx-controller",
      },
      {
        "name": "rbac.create",
        "value": "false",
      },
    ],
    version: "4.8.3",
  }, "cndi_nginx_controller_helm_chart");
  return getPrettyJSONString(resource);
}
