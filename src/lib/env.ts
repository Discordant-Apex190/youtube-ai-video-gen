type GlobalWithProcess = typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
};

const globalProcess = globalThis as GlobalWithProcess;

export function getEnv(name: string): string | undefined {
  return globalProcess.process?.env?.[name];
}

export function requireEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getBooleanEnv(name: string, defaultValue = false): boolean {
  const value = getEnv(name);
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const runtimeEnv = {
  get isDev() {
    return getEnv("NODE_ENV") !== "production";
  },
};
