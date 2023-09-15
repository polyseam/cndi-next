export default function getStorageClassManifestYamlTftpl() {
  return `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs
provisioner: filestore.csi.storage.gke.io
parameters:
  tier: standard
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
`.trim();
}
