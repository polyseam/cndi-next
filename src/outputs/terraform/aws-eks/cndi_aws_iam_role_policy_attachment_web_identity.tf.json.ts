import { getPrettyJSONString, getTFResource } from "src/utils.ts";

export default function getAWSIamRolePolicyAttachmentEKSWorkerNodeTFJSON(): string {
  const resource = getTFResource("aws_iam_role_policy_attachment", {
    policy_arn: "${aws_iam_policy.cndi_aws_iam_policy_web_identity.arn}",
    role: "${aws_iam_role.cndi_aws_iam_role_web_identity.name}",
  }, "cndi_aws_iam_role_policy_attachment_web_identity");
  return getPrettyJSONString(resource);
}
