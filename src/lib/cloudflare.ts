import { getCloudflareContext } from "@opennextjs/cloudflare";

export function getEnv() {
  return getCloudflareContext().env;
}

export function getExecutionContext() {
  return getCloudflareContext().ctx;
}

export function getCf() {
  return getCloudflareContext().cf;
}
