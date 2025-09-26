declare module "@opennextjs/cloudflare" {
  type CloudflareContext = {
    env: CloudflareEnv;
    ctx: ExecutionContext;
  cf: unknown;
  };

  export function getCloudflareContext(): CloudflareContext;
  export function initOpenNextCloudflareForDev(): void;
}
