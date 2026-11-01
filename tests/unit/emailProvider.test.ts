import { beforeEach, describe, expect, it, vi } from "vitest";
import { createResendProvider, EmailError, type EmailMessage } from "@/lib/email/provider";

vi.mock("@/lib/config/env", () => ({ getServerEnv: vi.fn() }));

import { getServerEnv } from "@/lib/config/env";
import { getEmailProvider } from "@/lib/email/server";

const KEY = "re_test_SENTINEL_KEY_0123456789";
const FROM = "Agent-Court <court@example.com>";
const TO = "operator-SENTINEL@example.com";
const BODY = "SENTINEL_BODY_FROM_SERVER";
const message: EmailMessage = { to: TO, subject: "SENTINEL_SUBJECT", html: "<p>SENTINEL_HTML</p>", text: "SENTINEL_TEXT" };

type Call = { url: string; init: RequestInit };
function recordingFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const ok = () => new Response(JSON.stringify({ id: "abc" }), { status: 200, headers: { "content-type": "application/json" } });

async function failureOf(promise: Promise<unknown>): Promise<EmailError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EmailError);
    return error as EmailError;
  }
  throw new Error("expected the call to fail");
}

/** An error says what kind of failure it was and nothing else: no key, no address, no subject, no body, no cause. */
function expectClean(error: EmailError) {
  const parts = [error.message, String(error), error.stack ?? "", JSON.stringify(error)];
  for (const name of Object.getOwnPropertyNames(error)) parts.push(String((error as unknown as Record<string, unknown>)[name]));
  const everything = parts.join(" ");
  for (const secret of [KEY, TO, "SENTINEL_SUBJECT", "SENTINEL_HTML", "SENTINEL_TEXT", BODY, "Bearer"]) expect(everything, secret).not.toContain(secret);
  expect(error.cause).toBeUndefined();
}

describe("createResendProvider: the request", () => {
  it("posts one message to the Resend endpoint with the key in the Authorization header only", async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    await createResendProvider(KEY, FROM, fetchImpl).send(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toMatch(/^application\/json/);
    expect(String(calls[0].init.body)).not.toContain(KEY);
  });

  it("sends the sender, the one recipient, the subject and both bodies, and nothing else", async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    await createResendProvider(KEY, FROM, fetchImpl).send(message);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: FROM, to: [TO], subject: "SENTINEL_SUBJECT", html: "<p>SENTINEL_HTML</p>", text: "SENTINEL_TEXT" });
  });

  it("answers nothing for an accepted message", async () => {
    const { fetchImpl } = recordingFetch(() => new Response("{}", { status: 202 }));
    await expect(createResendProvider(KEY, FROM, fetchImpl).send(message)).resolves.toBeUndefined();
  });
});

describe("createResendProvider: failures", () => {
  it.each([400, 401, 403, 404, 422])("calls a %i answer rejected, and keeps the status", async (status) => {
    const { fetchImpl } = recordingFetch(() => new Response(BODY, { status }));
    const error = await failureOf(createResendProvider(KEY, FROM, fetchImpl).send(message));
    expect(error.code).toBe("rejected");
    expect(error.status).toBe(status);
    expectClean(error);
  });

  it.each([429, 500, 502, 503])("calls a %i answer unavailable, which is worth trying again", async (status) => {
    const { fetchImpl } = recordingFetch(() => new Response(BODY, { status }));
    const error = await failureOf(createResendProvider(KEY, FROM, fetchImpl).send(message));
    expect(error.code).toBe("unavailable");
    expect(error.status).toBe(status);
    expectClean(error);
  });

  it("calls a connection failure unavailable, with no cause", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${TO} ${KEY}`);
    }) as typeof fetch;
    const error = await failureOf(createResendProvider(KEY, FROM, fetchImpl).send(message));
    expect(error.code).toBe("unavailable");
    expectClean(error);
  });

  it("gives up after the timeout and says so", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const error = await failureOf(createResendProvider(KEY, FROM, fetchImpl).send(message, { timeoutMs: 20 }));
    expect(error.code).toBe("timeout");
    expectClean(error);
  });

  it("never reads the body of a refusal", async () => {
    let seen: Response | undefined;
    const { fetchImpl } = recordingFetch(() => (seen = new Response(BODY, { status: 422 })));
    await failureOf(createResendProvider(KEY, FROM, fetchImpl).send(message));
    expect(seen?.bodyUsed).toBe(false);
  });

  it("has a different fixed message for each kind of failure", () => {
    const messages = new Set((["timeout", "rejected", "unavailable"] as const).map((code) => new EmailError(code).message));
    expect(messages.size).toBe(3);
  });
});

describe("getEmailProvider", () => {
  const env = (resendApiKey: string | null, emailFrom: string | null) =>
    vi.mocked(getServerEnv).mockReturnValue({ resendApiKey, emailFrom } as ReturnType<typeof getServerEnv>);

  beforeEach(() => vi.mocked(getServerEnv).mockReset());

  it("is null unless both settings are there, so nothing is ever sent", () => {
    env(null, null);
    expect(getEmailProvider()).toBeNull();
    env(KEY, null);
    expect(getEmailProvider()).toBeNull();
    env(null, FROM);
    expect(getEmailProvider()).toBeNull();
  });

  it("is a provider when both are set, and the same one each time", () => {
    env(KEY, FROM);
    const provider = getEmailProvider();
    expect(typeof provider?.send).toBe("function");
    expect(getEmailProvider()).toBe(provider);
  });
});
