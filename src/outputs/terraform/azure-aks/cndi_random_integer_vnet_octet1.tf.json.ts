import { getPrettyJSONString, getTFResource } from "src/utils.ts";

export default function getVnetsuffixTFJSON(): string {
  const resource = getTFResource("random_integer", {
    min: 0,
    max: 255,
  }, "cndi_random_integer_vnet_octet1");
  return getPrettyJSONString(resource);
}
