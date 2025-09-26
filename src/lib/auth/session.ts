import { getEnv, requireEnv } from "@/lib/env";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const SESSION_COOKIE_NAME = "yav_session";
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export type SessionIdentity = {
  sub: string;
  email?: string;
  name?: string;
};

export type SessionPayload = SessionIdentity & {
  issuedAt: number;
};

let keyPromise: Promise<CryptoKey> | null = null;

function base64UrlEncode(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data));
  return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (padded.length % 4)) % 4;
  const base64 = padded + "=".repeat(padLength);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getSessionSecret(): string {
  const secret = requireEnv("SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long");
  }
  return secret;
}

async function getKey(): Promise<CryptoKey> {
  if (!keyPromise) {
    const secretBytes = encoder.encode(getSessionSecret());
    keyPromise = crypto.subtle.importKey(
      "raw",
      secretBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  return keyPromise;
}

export async function createSessionValue(identity: SessionIdentity): Promise<string> {
  const payload: SessionPayload = {
    ...identity,
    issuedAt: Date.now(),
  };

  const serialized = JSON.stringify(payload);
  const data = encoder.encode(serialized);
  const key = await getKey();
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, data);
  const signature = base64UrlEncode(new Uint8Array(signatureBuffer));
  const encodedData = base64UrlEncode(data);
  return `${encodedData}.${signature}`;
}

export async function parseSessionValue(value: string | undefined | null): Promise<SessionPayload | null> {
  if (!value) return null;

  const [encodedData, signature] = value.split(".");
  if (!encodedData || !signature) return null;

  try {
    const dataBytes = base64UrlDecode(encodedData);
    const signatureBytes = base64UrlDecode(signature);
    const signatureBuffer = signatureBytes.buffer.slice(
      signatureBytes.byteOffset,
      signatureBytes.byteOffset + signatureBytes.byteLength,
    ) as ArrayBuffer;
    const dataBuffer = dataBytes.buffer.slice(
      dataBytes.byteOffset,
      dataBytes.byteOffset + dataBytes.byteLength,
    ) as ArrayBuffer;
    const key = await getKey();
    const isValid = await crypto.subtle.verify("HMAC", key, signatureBuffer, dataBuffer);
    if (!isValid) return null;

    const json = decoder.decode(dataBytes);
    const payload = JSON.parse(json) as SessionPayload;
    return payload;
  } catch (error) {
    console.error("Failed to parse session", error);
    return null;
  }
}

export function shouldBypassSession(): boolean {
  const bypass = getEnv("DEV_AUTH_BYPASS_SESSION");
  if (bypass === undefined) return false;
  return ["1", "true", "yes"].includes(bypass.toLowerCase());
}
