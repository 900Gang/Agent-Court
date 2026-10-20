import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { getServerEnv } from "@/lib/config/env";
import { errorResponse } from "@/lib/http/errors";
import { decideProxyAction } from "@/lib/http/proxyPolicy";

// The decision lives in lib/http/proxyPolicy.ts (tested). A session cookie is only a cheap check:
// real validation happens in getOperator() inside each page or action.
export function proxy(request: NextRequest) {
  const action = decideProxyAction({
    pathname: request.nextUrl.pathname,
    hasSessionCookie: Boolean(getSessionCookie(request)),
    killSwitch: getServerEnv().killSwitch,
  });
  if (action === "kill_switch") return errorResponse("kill_switch");
  if (action === "redirect_login") return NextResponse.redirect(new URL("/auth/login", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*", "/admin/:path*", "/api/v1/:path*", "/mcp/:path*"],
};
