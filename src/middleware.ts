import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  getAccessLoginUrl,
  getDevBypassIdentity,
  verifyAccessToken,
} from "@/lib/auth/access";
import {
  SESSION_COOKIE_MAX_AGE,
  SESSION_COOKIE_NAME,
  createSessionValue,
  shouldBypassSession,
} from "@/lib/auth/session";
import { runtimeEnv } from "@/lib/env";

const PUBLIC_PATHS = ["/api/health", "/api/status"];
const STATIC_PATH_REGEX = /^(?:\/(_next|favicon\.ico|robots\.txt|sitemap\.xml|manifest\.webmanifest|app-icon\.png|apple-touch-icon\.png|public))/;

function isPublicPath(path: string) {
  return PUBLIC_PATHS.includes(path) || STATIC_PATH_REGEX.test(path);
}

function buildLoginRedirect(request: NextRequest) {
  const loginUrl = new URL(getAccessLoginUrl());
  loginUrl.searchParams.set("redirect_url", request.nextUrl.href);
  return NextResponse.redirect(loginUrl);
}

export async function middleware(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const accessHeader = request.headers.get("cf-access-jwt-assertion");
  const accessCookie = request.cookies.get("CF_Authorization")?.value;

  let identityResult = await verifyAccessToken(accessHeader ?? accessCookie ?? "");

  if (identityResult.type === "unauthorized" && runtimeEnv.isDev) {
    const devIdentity = getDevBypassIdentity(request.headers);
    if (devIdentity) {
      identityResult = {
        type: "success",
        identity: { ...devIdentity, token: "dev" },
      };
    }
  }

  if (identityResult.type === "unauthorized") {
    return buildLoginRedirect(request);
  }

  if (identityResult.type === "error") {
    console.error("Failed to verify Cloudflare Access token", identityResult.error);
    return buildLoginRedirect(request);
  }

  const { identity } = identityResult;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-user-sub", identity.sub);
  if (identity.email) requestHeaders.set("x-user-email", identity.email);
  if (identity.name) requestHeaders.set("x-user-name", identity.name);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (!shouldBypassSession()) {
    const sessionValue = await createSessionValue({
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
    });

    response.cookies.set(SESSION_COOKIE_NAME, sessionValue, {
      httpOnly: true,
      secure: !runtimeEnv.isDev,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_COOKIE_MAX_AGE,
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots\\.txt|manifest\\.webmanifest|apple-touch-icon\\.png|app-icon\\.png).*)"],
};
