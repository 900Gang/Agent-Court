import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/safety/normalize";
import { PATTERNS } from "@/lib/safety/patterns";
import { redactText, redactedRatio } from "@/lib/safety/redact";
import { loadClean, loadSecrets } from "../helpers/corpus";

// Values are assembled at run time so no complete token is written in this public repository.
const j = (...pieces: string[]) => pieces.join("");
const BS = String.fromCharCode(92);
const CYCLE = "Zk9pQ3x7LmN2vB8wR5tY1cH4jD6sF0aG";
const body = (n: number, offset = 0) => CYCLE.repeat(Math.ceil((n + offset) / CYCLE.length) + 1).slice(offset, offset + n);
const urlsafe = (n: number) => `${body(Math.floor(n / 2))}-_${body(n - Math.floor(n / 2) - 2, 3)}`;
const ph = (type: string) => `[REDACTED:${type}]`;
const HEX16 = "0123456789abcdef";
const SHA40 = "9fceb02d0ae598e95dc970b74767f19372d61af4";
const UUID = "3f2b8c1e-5d2a-4b7e-9c3d-1a2b3c4d5e6f";
const norm = (value: string) => normalizeText(value).text;

describe("redactText: fixed-format secrets", () => {
  const SAMPLES: Array<[string, string]> = [
    ["github_token", j("ghp", "_", body(36))],
    ["aws_access_key", j("AKIA", "ZXQ4MN7PLKD2RT9W")],
    ["openai_key", j("sk", "-", body(48))],
    ["anthropic_key", j("sk", "-ant-api03-", urlsafe(95))],
    ["stripe_key", j("sk", "_live_", body(24))],
    ["slack_token", j("xoxb", "-", "123456789012", "-", "123456789012", "-", body(24))],
    ["google_api_key", j("AIza", urlsafe(35))],
    ["npm_token", j("npm", "_", body(36))],
    ["jwt", j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiJ1c3JfMSJ9", ".", urlsafe(43))],
    ["ac_api_key", j("ac", "_live_", body(32))],
    ["email", "person@company.io"],
    ["phone", "+14155550100"],
    ["card", "4111 1111 1111 1111"],
    ["ssn", "514-33-1298"],
  ];

  it.each(SAMPLES)("replaces a %s with its placeholder and reports where it was", (type, secret) => {
    const result = redactText(`Use ${secret} here.`);
    expect(result.text).toBe(`Use ${ph(type)} here.`);
    expect(result.items).toEqual([{ type, start: 4, length: secret.length }]);
  });

  it("replaces a whole private key block with one placeholder", () => {
    const block = [j("-----BEGIN RSA PRIV", "ATE KEY-----"), body(64), body(64, 5), j("-----END RSA PRIV", "ATE KEY-----")].join("\n");
    expect(redactText(`Loaded key:\n${block}\nkey loaded`).text).toBe(`Loaded key:\n${ph("private_key")}\nkey loaded`);
  });

  it("keeps the word Bearer and redacts only the token", () => {
    expect(redactText(`Authorization: Bearer ${body(40)}`).text).toBe(`Authorization: Bearer ${ph("bearer_token")}`);
  });

  it("redacts only the password inside a URL with credentials", () => {
    expect(redactText("DATABASE_URL=postgres://svc:Tr0ub4dor&3xq@db.example:5432/x").text).toBe(
      `DATABASE_URL=postgres://svc:${ph("basic_auth_url")}@db.example:5432/x`,
    );
  });

  it("makes one placeholder where two matches overlap", () => {
    const result = redactText(`postgres://svc:${j("ghp", "_", body(36))}@db.example:5432/x`);
    expect(result.text).toMatch(/^postgres:\/\/svc:\[REDACTED:\w+\]@db\.example:5432\/x$/);
    expect(result.items).toHaveLength(1);
  });

  it("leaves example-domain addresses and redacts real ones", () => {
    expect(redactText("mail a@example.com or person@company.io").text).toBe(`mail a@example.com or ${ph("email")}`);
  });
});

describe("redactText: values after secret-like names", () => {
  const generic = ph("generic_secret");
  const REDACTED: Array<[string, string]> = [
    ["password=hunter2", `password=${generic}`],
    ["DB_PASSWORD=Summer2024xk!\nDB_HOST=db.internal.example", `DB_PASSWORD=${generic}\nDB_HOST=db.internal.example`],
    ['{"api_key": "abcdef123456", "user": "ana"}', `{"api_key": "${generic}", "user": "ana"}`],
    ['{"client_secret": "correct-horse-battery", "client_id": "web-app"}', `{"client_secret": "${generic}", "client_id": "web-app"}`],
    [
      `{"msg": "body: {${BS}"api_key${BS}": ${BS}"sup3r-s3cret-v4lue${BS}", ${BS}"user${BS}": 7}"}`,
      `{"msg": "body: {${BS}"api_key${BS}": ${BS}"${generic}${BS}", ${BS}"user${BS}": 7}"}`,
    ],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", `Authorization: Basic ${generic}`],
    ["X_API_KEY: abc123def456", `X_API_KEY: ${generic}`],
    ["secret: correct-horse-battery", `secret: ${generic}`],
    ["Api_Key = tr0ub4dor-and-3-more", `Api_Key = ${generic}`],
    [`AWS_SECRET_ACCESS_KEY=${body(40)}`, `AWS_SECRET_ACCESS_KEY=${generic}`],
    [`api_key=${UUID}`, `api_key=${generic}`],
    ["GET /cb?access_token=abc123def456ghi&state=ok 200", `GET /cb?access_token=${generic}&state=ok 200`],
    ["//registry.npmjs.org/:_authToken=abc123def456ghi", `//registry.npmjs.org/:_authToken=${generic}`],
  ];

  it.each(REDACTED)("redacts the value in %j, and only the value", (input, expected) => {
    const result = redactText(input);
    expect(result.text).toBe(expected);
    expect(result.items.length).toBeGreaterThan(0);
  });

  it("redacts a value that is itself allowlisted (a UUID or a 40-character hex string), because the name says it is secret", () => {
    expect(redactText(`GITHUB_TOKEN=${SHA40}`).text).toBe(`GITHUB_TOKEN=${generic}`);
  });

  const UNCHANGED = [
    "invalid token: expected 3 segments",
    "Error: invalid token format",
    "token expired for user",
    "the secret is stored in the vault",
    "API_KEY=<your-api-key>",
    "SECRET_KEY=your-secret-key-here",
    "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "NPM_TOKEN: ${NPM_TOKEN}",
    '{"max_tokens":1024,"temperature":0.2,"usage":{"prompt_tokens":512,"completion_tokens":128,"total_tokens":640}}',
    "tokenizer: cl100k_base\ntoken_count: 3412\nmax_input_tokens: 128000",
    "Authorization: Bearer ${TOKEN}",
    "Authorization: Bearer ***",
    "curl -H 'Authorization: Bearer <token>' https://api.example.com",
    '"api_key":{"type":"string","description":"The key to store"}',
    "password=***",
    "token=null",
    "secret=changeme",
    "password=xxxxxxxx",
    '"api_key": "abc"',
    "secret_manager=aws-secretsmanager",
    "api_key_header: X-Api-Key",
    "password=[REDACTED:generic_secret]",
    `{"api_key": "[REDACTED:generic_secret]"}`,
  ];

  it.each(UNCHANGED)("leaves %j alone", (input) => {
    expect(redactText(input)).toEqual({ text: input, items: [] });
  });
});

describe("redactText: high-entropy tokens and the allowlist", () => {
  const entropy = ph("high_entropy");

  it("redacts a long random-looking token with letters and digits", () => {
    expect(redactText(`Session ${body(32, 3)} expired`).text).toBe(`Session ${entropy} expired`);
  });

  it("redacts a base64 token that contains slashes", () => {
    const value = j(body(13), "/", body(12, 4), "/", body(14, 9));
    expect(redactText(`Key ${value} end`).text).toBe(`Key ${entropy} end`);
  });

  it("redacts a 32 or 64 character hex string, with or without a word before it", () => {
    expect(redactText(`secret ${HEX16.repeat(4)} end`).text).toBe(`secret ${entropy} end`);
    expect(redactText(`nonce ${HEX16.repeat(2)}`).text).toBe(`nonce ${entropy}`);
  });

  const UNCHANGED = [
    `image sha256:${HEX16.repeat(4)}`,
    `FROM node:22-alpine@sha256:${HEX16.repeat(4)}`,
    `pulled ghcr.io/acme/agent@sha256:${HEX16.repeat(4)} ok`,
    `integrity sha512-${createHash("sha512").update("lock").digest("base64")}`,
    `commit ${SHA40}`,
    `request ${UUID} failed`,
    `etag: W/"${SHA40.slice(0, 20)}" trace ${SHA40.slice(0, 16)}`,
    `${HEX16.repeat(2).slice(0, 31)}`,
    "The quick brown fox jumps over the lazy dog near the riverbank, then rests.",
    "getUserAccountPreferencesFromRepository was called twice",
    "getUserAccountPreferencesV2FromRepositoryWithFallback was called twice",
    "com.acme.agent.framework.config.DefaultSettingsLoader threw",
    "/home/runner/work/agent-court/agent-court/src/lib/safety/redact.ts",
    "/usr/lib/python3.11/site-packages/agent_framework/config/defaults.yaml",
    "2026-10-24T09:14:02Z elapsed=1729761234567 ms pid 41233",
    "dGVzdA== and aGVsbG8gd29ybGQ=",
  ];

  it.each(UNCHANGED)("leaves %j alone", (input) => {
    expect(redactText(input)).toEqual({ text: input, items: [] });
  });
});

describe("redactText: report", () => {
  it("returns items sorted by position, without overlap, that select exactly the removed spans", () => {
    const input = `a ${j("ghp", "_", body(36))} b password=hunter2 c person@company.io d ${body(32, 5)} e`;
    const { text, items } = redactText(input);
    expect(items.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < items.length; i++) expect(items[i].start).toBeGreaterThanOrEqual(items[i - 1].start + items[i - 1].length);
    let rebuilt = "";
    let cursor = 0;
    for (const item of items) {
      expect(item.length).toBeGreaterThan(0);
      rebuilt += input.slice(cursor, item.start) + ph(item.type);
      cursor = item.start + item.length;
    }
    expect(rebuilt + input.slice(cursor)).toBe(text);
  });

  it("only uses known type names", () => {
    const known = new Set([...PATTERNS.map((rule) => rule.type), "generic_secret", "high_entropy"]);
    for (const entry of loadSecrets()) {
      for (const item of redactText(norm(entry.text)).items) expect(known.has(item.type), `${entry.id}: ${item.type}`).toBe(true);
    }
  });

  it("is idempotent, and its report never holds a matched value, for every secret in the corpus", () => {
    for (const entry of loadSecrets()) {
      const once = redactText(norm(entry.text));
      expect(redactText(once.text).text, entry.id).toBe(once.text);
      expect(JSON.stringify(once.items), entry.id).not.toContain(norm(entry.secret));
      expect(Object.keys(once.items[0] ?? { type: 1, start: 1, length: 1 }).sort(), entry.id).toEqual(["length", "start", "type"]);
    }
  });

  it("returns empty and whitespace-only input unchanged", () => {
    expect(redactText("")).toEqual({ text: "", items: [] });
    expect(redactText("  \n\t ")).toEqual({ text: "  \n\t ", items: [] });
  });
});

describe("redactedRatio", () => {
  it("is the share of characters that were redacted", () => {
    const token = j("ghp", "_", body(36));
    const whole = redactText(token);
    expect(redactedRatio(token, whole.items)).toBe(1);
    const part = `aaaa ${token}`;
    expect(redactedRatio(part, redactText(part).items)).toBeCloseTo(token.length / part.length, 5);
    expect(redactedRatio("plain text", [])).toBe(0);
    expect(redactedRatio("", [])).toBe(0);
  });
});

describe("redactText against the development corpora", () => {
  // Rules are tuned on the dev set only; the holdout set is measured once, in the acceptance test.
  it("removes every dev secret, with an accepted placeholder, and keeps what must stay", () => {
    for (const entry of loadSecrets().filter((e) => e.set === "dev")) {
      const input = norm(entry.text);
      const { text, items } = redactText(input);
      expect(text, `${entry.id} still contains its secret`).not.toContain(norm(entry.secret));
      expect(items.some((item) => entry.accepts.includes(item.type)), `${entry.id}: types ${items.map((i) => i.type)}`).toBe(true);
      for (const keep of entry.keep) expect(text, `${entry.id} lost ${keep}`).toContain(keep);
    }
  });

  it("changes no dev clean trace", () => {
    for (const entry of loadClean().filter((e) => e.set === "dev" && !e.allowAltered)) {
      const input = norm(entry.text);
      expect(redactText(input), entry.id).toEqual({ text: input, items: [] });
    }
  });
});

describe("redactText: speed on hostile input", () => {
  const BIG = 32_000;
  const inputs: Array<[string, string]> = [
    ["a", "a".repeat(BIG)],
    ["a1", "a1".repeat(BIG / 2)],
    ["=", "=".repeat(BIG)],
    ["password=", "password=".repeat(BIG / 9)],
    ["token=", "token=".repeat(BIG / 6)],
    ['"api_key": "', '"api_key": "'.repeat(BIG / 12)],
    ["A-", "A-".repeat(BIG / 2)],
    ["random base64", body(BIG)],
    ["a long hex run", HEX16.repeat(BIG / 16)],
    ["ac_live_", "ac_live_".repeat(BIG / 8)],
    ["[REDACTED:x]", "[REDACTED:x]".repeat(BIG / 12)],
    ["sha256:", "sha256:".repeat(BIG / 7)],
    ["secret key words", "secret_key authorization credential ".repeat(BIG / 35)],
    ["slashes", "ab/".repeat(BIG / 3)],
    ["newlines", "\n".repeat(BIG)],
  ];

  it.each(inputs)("redacts 32,000 characters of %j within 500 ms", (_label, text) => {
    const start = Date.now();
    redactText(text);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
