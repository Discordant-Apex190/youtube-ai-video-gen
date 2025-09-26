import { createRemoteJWKSet, jwtVerify } from "jose";
import { getEnv, requireEnv } from "@/lib/env";

export type AccessIdentity = {
  sub: string;
  email?: string;
  name?: string;
  issuer?: string;
  token: string;
};

export type AccessVerificationResult =
  | { type: "success"; identity: AccessIdentity }
  | { type: "error"; error: Error }
  | { type: "unauthorized" };

type AccessConfig = {
  audience: string;
  certsUrl: string;
  loginUrl: string;
  algorithm?: string;
};

let cachedConfig: AccessConfig | null = null;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function resolveAccessConfig(): AccessConfig {
  if (cachedConfig) return cachedConfig;

  const audience = requireEnv("CF_ACCESS_AUD");
  const algorithm = getEnv("CF_ACCESS_JWT_ALG");
  const certsUrl =
    getEnv("CF_ACCESS_CERTS_URL") ??
    (() => {
      const teamDomain = getEnv("CF_ACCESS_TEAM_DOMAIN");
      if (!teamDomain) {
        throw new Error(
          "Provide either CF_ACCESS_CERTS_URL or CF_ACCESS_TEAM_DOMAIN to verify Cloudflare Access tokens.",
        );
      }
      const sanitized = teamDomain.startsWith("http") ? teamDomain : `https://${teamDomain}`;
      return `${sanitized.replace(/\/$/, "")}/cdn-cgi/access/certs`;
    })();

  const loginUrl =
    getEnv("CF_ACCESS_LOGIN_URL") ??
    certsUrl.replace(/\/cdn-cgi\/access\/certs$/, "/cdn-cgi/access/login");

  cachedConfig = { audience, certsUrl, algorithm, loginUrl };
  return cachedConfig;
}

function getJwks(certsUrl: string) {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(certsUrl));
  }
  return cachedJwks;
}

export async function verifyAccessToken(token: string): Promise<AccessVerificationResult> {
  const trimmed = token?.trim();
  if (!trimmed) return { type: "unauthorized" };

  try {
    const config = resolveAccessConfig();
    const jwks = getJwks(config.certsUrl);
    const { payload, protectedHeader } = await jwtVerify(trimmed, jwks, {
      audience: config.audience,
      algorithms: config.algorithm ? [config.algorithm] : undefined,
    });

    if (config.algorithm && protectedHeader.alg !== config.algorithm) {
      return { type: "error", error: new Error("Unexpected Access token algorithm") };
    }

    return {
      type: "success",
      identity: {
        sub: payload.sub as string,
        email: (payload.email as string) ?? (payload.identity_email as string) ?? undefined,
        name: (payload.name as string) ?? (payload.common_name as string) ?? undefined,
        issuer: payload.iss as string | undefined,
        token: trimmed,
      },
    };
  } catch (error) {
    return { type: "error", error: error as Error };
  }
}

export function getAccessLoginUrl() {
  const config = resolveAccessConfig();
  return config.loginUrl;
}

export type DevBypassIdentity = {
  sub: string;
  email: string;
  name?: string;
};

export function getDevBypassIdentity(headers: Headers): DevBypassIdentity | null {
  const bypassToken = getEnv("DEV_AUTH_BYPASS_TOKEN");
  if (!bypassToken) return null;

  const provided = headers.get("x-dev-auth");
  if (!provided || provided !== bypassToken) return null;

  const email = headers.get("x-dev-email") ?? "dev@example.com";
  const name = headers.get("x-dev-name") ?? "Dev User";
  const subject = headers.get("x-dev-sub") ?? `dev-${email}`;

  return { sub: subject, email, name };
}
