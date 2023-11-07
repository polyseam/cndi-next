import {
  getPrettyJSONString,
  getTFResource,
  getUserDataTemplateFileString,
} from "src/utils.ts";
import { AWSEC2NodeItemSpec } from "src/types.ts";
import { DEFAULT_INSTANCE_TYPES, DEFAULT_NODE_DISK_SIZE } from "consts";

export default function getAWSComputeInstanceTFJSON(
  node: AWSEC2NodeItemSpec,
  leaderNodeName: string,
): string {
  const { name, role } = node;
  const root_block = node.disk_size.find((disk) => disk.name === 'default');
  const DEFAULT_EC2_AMI = "ami-0c1704bac156af62c";
  const ami = node?.ami || DEFAULT_EC2_AMI;
  const instance_type = node?.instance_type || DEFAULT_INSTANCE_TYPES.aws;
  const delete_on_termination = true;
  const volume_size = node?.volume_size || node?.disk_size || node?.size ||
    node?.disk_size_gb || DEFAULT_NODE_DISK_SIZE; //GiB
  const volume_type = "gp3"; // general purpose SSD
  const subnet_id = `\${aws_subnet.cndi_aws_subnet[0].id}`;
  const vpc_security_group_ids = [
    "${aws_security_group.cndi_aws_security_group.id}",
  ];
  const root_block_device = [
    {
      volume_size,
      volume_type,
      delete_on_termination,
    },
  ];
  const leaderAWSInstance = `aws_instance.cndi_aws_instance_${leaderNodeName}`;
  const user_data = getUserDataTemplateFileString(role);
  const depends_on = role !== "leader"
    ? ["aws_internet_gateway.cndi_aws_internet_gateway", leaderAWSInstance]
    : ["aws_internet_gateway.cndi_aws_internet_gateway"];

  const resource = getTFResource(
    "aws_instance",
    {
      ami,
      instance_type,
      tags: {
        Name: name,
        CNDINodeRole: role,
      },
      root_block_device,
      ebs_block_device: [
        {
          device_name: "/dev/sdb",
          volume_size,
          volume_type,
          delete_on_termination,
        }
      ],
      subnet_id,
      vpc_security_group_ids,
      user_data_replace_on_change: false,
      user_data,
      depends_on,
    },
    `cndi_aws_instance_${node.name}`,
  ).resource;

  return getPrettyJSONString({
    resource,
  });
}
