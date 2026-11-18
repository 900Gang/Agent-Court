import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { onRequestError } from "@/instrumentation";
import type { ApiScope } from "@/lib/config/constants";
import { runApi, type ApiDeps } from "@/lib/http/apiPipeline";
import { handleFileCase } from "@/lib/http/handlers/cases";
import { logger } from "@/lib/config/logger";
import { createMemoryLimiter } from "@/lib/ratelimit/memory";
import { createGate } from "@/lib/safety/engine";
import { issueKey } from "@/lib/services/keyService";
import { createFixtures } from "../helpers/fixtures";
import { createTestDb, type TestDb } from "../helpers/db";

// N10 Task 2 (AC-1003, AC-1004): a planted secret in a request body, a header, a cookie, a query string and a thrown
// error's message must appear in no line that the logger or the error hook writes. Everything is captured from the
// console, which is where Vercel's runtime logs come from. The secrets are assembled at run time: the repository is public.
//
// Known limit, in the spec: Next.js itself may print a thrown error's stack before the hook runs. This test checks what
// our code emits. The owner repeats the check on staging in Vercel's runtime logs (runbook).

let t: TestDb;
let f: ReturnType<typeof createFixtures>;

beforeAll(async () => {
  t = await createTestDb();
  await t.sql("set role app_server");
  f = createFixtures(t);
});

afterAll(async () => {
  await t.sql("reset role");
  await t.close();
});

const awsKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const OPAQUE = ["zq7vK2mX", "p9Lw4Tn8", "Bc3Yd6Rh"].join(""); // not shaped like any token the scrubber knows
const COOKIE = ["sess", "9Hf3kLq2", "Vx8Rm1Pa"].join("");
const QUERY = ["q", "7Gd4Wn2Ys", "5Tb8Jc"].join("");
const SECRETS = [awsKey, OPAQUE, COOKIE, QUERY];

const spies = (["debug", "info", "warn", "error", "log"] as const).map((level) => vi.spyOn(console, level));
beforeEach(() => spies.forEach((spy) => spy.mockImplementation(() => undefined)));
afterEach(() => spies.forEach((spy) => spy.mockClear()));
const captured = () => spies.flatMap((spy) => spy.mock.calls.flat()).map(String).join("\n");

/** No whole secret and no run of eight of its characters appears in the text. */
function expectNoTrace(text: string, secrets: string[] = SECRETS) {
  for (const secret of secrets) {
    for (let start = 0; start + 8 <= secret.length; start += 1) {
      expect(text, `a piece of a planted secret (${secret.length} characters) was logged`).not.toContain(secret.slice(start, start + 8));
    }
  }
}

const DAY = 86_400_000;
const now = new Date(Date.now() + 30 * DAY);
const deps = (): ApiDeps => ({ db: t.db, limiter: createMemoryLimiter(() => now.getTime()), gate: createGate(), writesEnabled: true, now });

async function agentWithKey(scopes: ApiScope[] = ["read", "cases:write", "arguments:write"]) {
  const made = await f.makeAgent();
  const issued = f.unwrap(await issueKey(t.db, made.operator, made.agent.id, { scopes }));
  return { ...made, key: issued.key };
}

const requestFor = (key: string, body: unknown) =>
  new Request(`http://localhost:3000/api/v1/cases?token=${QUERY}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", cookie: `session=${COOKIE}`, "x-trace": OPAQUE },
    body: JSON.stringify(body),
  });

const caseBody = (over: Record<string, unknown> = {}) => ({
  title: "Tool call loops",
  summary: "The agent repeats a call.",
  expected: "One call.",
  actual: "Ten calls.",
  tags: [],
  environment: {},
  evidence: [{ kind: "trace", text: "step 1" }],
  ...over,
});

const hookRequest = (extra: Record<string, string> = {}) => ({
  path: `/api/v1/cases?token=${QUERY}`,
  method: "POST",
  headers: { authorization: `Bearer ${OPAQUE}`, cookie: `session=${COOKIE}`, "x-trace": OPAQUE, ...extra },
});
const hookContext = { routerKind: "App Router", routePath: "/app/api/v1/cases/route", routeType: "route", renderType: "dynamic" };

describe("a request that carries secrets and succeeds", () => {
  it("logs none of them", async () => {
    const a = await agentWithKey();
    const body = caseBody({
      summary: `The shell history held ${awsKey} and nothing else worth reading in it.`,
      evidence: [{ kind: "error", text: `crashed after ${awsKey} was echoed back in the log output line by line` }],
    });
    const response = await handleFileCase(requestFor(a.key, body), deps());
    expect(response.status).toBe(201);
    expectNoTrace(captured());
    expectNoTrace(await response.text(), [awsKey]);
  });
});

describe("a request that fails", () => {
  it("is not logged with its body, headers, cookie or query when the handler throws and the error reaches the hook", async () => {
    const a = await agentWithKey();
    let thrown: unknown;
    try {
      await runApi(
        requestFor(a.key, caseBody({ summary: `leaked ${awsKey}` })),
        deps(),
        { scope: "cases:write", write: true },
        async () => {
          throw new Error(`database said no for ${OPAQUE} and ${awsKey} and ${QUERY}`);
        },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    // What Next.js does next: it hands the error, the request and the route to the hook.
    await onRequestError(thrown, hookRequest(), hookContext);
    expectNoTrace(captured());
    expect(captured()).toContain("request error");
  });

  it("is not logged when the error is not an Error at all", async () => {
    await onRequestError(`token ${OPAQUE}`, hookRequest(), hookContext);
    await onRequestError({ message: OPAQUE, cause: awsKey }, hookRequest(), hookContext);
    expectNoTrace(captured());
  });

  it("is not logged when the error has a hostile name, a stack or a digest that holds the secret", async () => {
    const error = Object.assign(new Error("x"), { name: `Evil ${OPAQUE}`, digest: `${QUERY} ${OPAQUE}` });
    error.stack = `Error: ${OPAQUE}\n    at ${awsKey}`;
    await onRequestError(error, hookRequest(), hookContext);
    expectNoTrace(captured());
  });

  it("is not logged when the route path or method holds the secret", async () => {
    await onRequestError(new Error("x"), { ...hookRequest(), method: `GET ${OPAQUE}` }, { ...hookContext, routePath: `/app/${OPAQUE}?x=${QUERY}` });
    expectNoTrace(captured());
  });
});

describe("the logger itself", () => {
  it("scrubs a header-shaped and token-shaped value passed to it as data", () => {
    logger.error("something failed", { headers: { authorization: `Bearer ${OPAQUE}`, cookie: `session=${COOKIE}` }, token: OPAQUE, apiKey: awsKey });
    expectNoTrace(captured(), [OPAQUE, COOKIE]);
  });
});
