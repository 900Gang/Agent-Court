export type ProxyAction = "next" | "redirect_login" | "kill_switch";

const isUnder = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/**
 * What the proxy should do with a request. The kill switch stops agent traffic only
 * (/api/v1 and /mcp): operators can still sign in, revoke keys and suspend agents during an incident.
 */
export function decideProxyAction(input: {
  pathname: string;
  hasSessionCookie: boolean;
  killSwitch: boolean;
}): ProxyAction {
  const { pathname } = input;
  if (input.killSwitch && (isUnder(pathname, "/api/v1") || isUnder(pathname, "/mcp"))) {
    return "kill_switch";
  }
  if ((isUnder(pathname, "/dashboard") || isUnder(pathname, "/admin")) && !input.hasSessionCookie) {
    return "redirect_login";
  }
  return "next";
}
