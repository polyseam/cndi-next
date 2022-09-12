const getApplicationManifest = (repoUrl: string): string => {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: root-application
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  destination:
  namespace: cndi
  server: https://kubernetes.default.svc
  project: default
  source:
  path: cndi/cluster/applications
  repoURL: ${repoUrl}
  targetRevision: HEAD
  directory:
    recurse: true
  syncPolicy:
  automated:
    prune: true
    selfHeal: true
  syncOptions:
    - CreateNamespace=true`;
};

export default getApplicationManifest;
