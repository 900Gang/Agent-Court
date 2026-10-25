import { describe, expect, it } from "vitest";
import { normalizeText } from "@/lib/safety/normalize";
import { EMAIL_ALLOWED_DOMAINS, PATTERNS, isAllowedEmailDomain, luhnValid } from "@/lib/safety/patterns";
import { loadClean, loadSecrets } from "../helpers/corpus";

// Test values are assembled from short pieces at run time, so no complete token is written in this public repository.
const j = (...pieces: string[]) => pieces.join("");
const CYCLE = "Zk9pQ3x7LmN2vB8wR5tY1cH4jD6sF0aG";
const body = (n: number, offset = 0) => CYCLE.repeat(Math.ceil((n + offset) / CYCLE.length) + 1).slice(offset, offset + n);
const urlsafe = (n: number) => `${body(Math.floor(n / 2))}-_${body(n - Math.floor(n / 2) - 2, 3)}`;
const luhnComplete = (digits: string) => {
  for (let check = 0; check < 10; check++) if (luhnValid(digits + check)) return digits + check;
  throw new Error("no check digit");
};

type Found = { type: string; matched: string; start: number; end: number };

/** How the engine uses a rule: the capture group (or the whole match) is the secret, and `validate` can reject it. */
function findAll(text: string): Found[] {
  const found: Found[] = [];
  for (const rule of PATTERNS) {
    for (const match of text.matchAll(rule.regex)) {
      const span = rule.group !== undefined ? (match as RegExpMatchArray & { indices: Array<[number, number]> }).indices[rule.group] : undefined;
      const [start, end] = span ?? [match.index as number, (match.index as number) + match[0].length];
      const matched = text.slice(start, end);
      if (rule.validate && !rule.validate(matched)) continue;
      found.push({ type: rule.type, matched, start, end });
    }
  }
  return found;
}
const ofType = (text: string, type: string) => findAll(text).filter((f) => f.type === type);

const TYPES = [
  "aws_access_key", "github_token", "github_fine_grained", "openai_key", "anthropic_key", "stripe_key", "slack_token",
  "slack_webhook", "google_api_key", "google_oauth", "twilio_key", "sendgrid_key", "npm_token", "huggingface_token",
  "gitlab_token", "telegram_bot_token", "azure_storage_key", "jwt", "bearer_token", "basic_auth_url", "private_key",
  "ac_api_key", "email", "phone", "card", "ssn",
];

describe("pattern catalogue shape", () => {
  it("has at least one rule for each of the 26 types and no other types", () => {
    const found = new Set(PATTERNS.map((rule) => rule.type));
    for (const type of TYPES) expect(found.has(type), type).toBe(true);
    for (const type of found) expect(TYPES, type).toContain(type);
  });

  it("uses global regexes, and the d flag when a capture group is the secret", () => {
    for (const rule of PATTERNS) {
      expect(rule.regex.flags, rule.type).toContain("g");
      if (rule.group !== undefined) expect(rule.regex.flags, rule.type).toContain("d");
    }
  });
});

const POSITIVE: Array<{ type: string; secret: string; template?: string }> = [
  { type: "aws_access_key", secret: j("AKIA", "ZXQ4MN7PLKD2RT9W") },
  { type: "aws_access_key", secret: j("ASIA", "ZXQ4MN7PLKD2RT9W"), template: "AWS_ACCESS_KEY_ID={{S}}\nAWS_REGION=us-east-1" },
  { type: "github_token", secret: j("ghp", "_", body(36)) },
  { type: "github_token", secret: j("gho", "_", body(36, 4)), template: "token={{S}}&x=1" },
  { type: "github_token", secret: j("ghu", "_", body(36, 7)) },
  { type: "github_token", secret: j("ghs", "_", body(36, 9)) },
  { type: "github_token", secret: j("ghr", "_", body(36, 11)) },
  { type: "github_fine_grained", secret: j("github", "_pat_", body(22), "_", body(59, 5)) },
  { type: "openai_key", secret: j("sk", "-", body(48)) },
  { type: "openai_key", secret: j("sk", "-proj-", body(74, 2)), template: "Incorrect API key provided: {{S}}. Check your key." },
  { type: "anthropic_key", secret: j("sk", "-ant-api03-", urlsafe(95)) },
  { type: "stripe_key", secret: j("sk", "_live_", body(24)) },
  { type: "stripe_key", secret: j("rk", "_live_", body(24, 6)) },
  { type: "stripe_key", secret: j("sk", "_test_", body(24, 9)) },
  { type: "slack_token", secret: j("xoxb", "-", "123456789012", "-", "123456789012", "-", body(24)) },
  { type: "slack_token", secret: j("xoxp", "-", "123456789012", "-", "123456789012", "-", "123456789012", "-", "0123456789abcdef0123456789abcdef") },
  { type: "slack_webhook", secret: j("https://hooks.slack", ".com/services/T", "01ABCDEFG", "/B", "01ABCDEFGHI", "/", body(24)) },
  { type: "google_api_key", secret: j("AIza", urlsafe(35)) },
  { type: "google_oauth", secret: j("ya29", ".a0A", urlsafe(100)), template: "Authorization: Bearer {{S}}" },
  { type: "twilio_key", secret: j("SK", "0123456789abcdef0123456789abcdef") },
  { type: "sendgrid_key", secret: j("SG", ".", urlsafe(22), ".", urlsafe(43)) },
  { type: "npm_token", secret: j("npm", "_", body(36)) },
  { type: "huggingface_token", secret: j("hf", "_", body(34)) },
  { type: "gitlab_token", secret: j("glpat", "-", urlsafe(20)) },
  { type: "telegram_bot_token", secret: j("123456789", ":AA", urlsafe(33)), template: "GET https://api.telegram.org/bot{{S}}/getMe" },
  { type: "azure_storage_key", secret: j(body(86), "=="), template: "AccountName=assetsprod;AccountKey={{S}};EndpointSuffix=core.windows.net" },
  { type: "jwt", secret: j("eyJ", "hbGciOiJIUzI1NiJ9", ".", "eyJ", "zdWIiOiJ1c3JfMSJ9", ".", urlsafe(43)) },
  { type: "bearer_token", secret: body(40), template: "Authorization: Bearer {{S}}\nAccept: application/json" },
  { type: "bearer_token", secret: j(body(30), "=="), template: 'headers = {"Authorization": "bearer {{S}}"}' },
  { type: "basic_auth_url", secret: "Tr0ub4dor&3xq", template: "DATABASE_URL=postgres://svc_reports:{{S}}@db.internal.example:5432/reports" },
  { type: "basic_auth_url", secret: "p4ss", template: "git clone https://deploy:{{S}}@git.example.com/acme/infra.git" },
  { type: "ac_api_key", secret: j("ac", "_live_", body(32)) },
  { type: "ac_api_key", secret: j("ac", "_test_", body(32, 8)), template: "AGENT_COURT_KEY={{S}}" },
  { type: "ac_api_key", secret: j("ac", "_live_", "abcd1234") },
  { type: "email", secret: "person@company.io" },
  { type: "email", secret: "first.last+tag@sub.domain.co.uk", template: "Contact: {{S}}." },
  { type: "phone", secret: "+14155550100" },
  { type: "phone", secret: "(415) 555-0100" },
  { type: "phone", secret: "415-555-0100", template: "Call {{S}} now" },
  { type: "phone", secret: "415.555.0100" },
  { type: "phone", secret: "+44 20 7946 0958" },
  { type: "card", secret: "4111 1111 1111 1111" },
  { type: "card", secret: "4111-1111-1111-1111" },
  { type: "card", secret: "4111111111111111" },
  { type: "card", secret: "378282246310005" },
  { type: "card", secret: "3782 822463 10005" },
  { type: "card", secret: "5555555555554444", template: "card_number={{S}} exp=12/29" },
  { type: "card", secret: "4222222222222" },
  { type: "card", secret: "6799990100000000019" },
  { type: "ssn", secret: "123-45-6789" },
  { type: "ssn", secret: "514-33-1298", template: "ssn: {{S}}." },
];

describe("pattern catalogue: positives", () => {
  it.each(POSITIVE.map((p) => [p.type, p.secret.slice(0, 6), p] as const))("%s starting %s... is matched in full, and only it", (_type, _label, entry) => {
    const text = (entry.template ?? "before {{S}} after").replace("{{S}}", entry.secret);
    const hits = ofType(text, entry.type);
    expect(hits, `no ${entry.type} match`).toHaveLength(1);
    expect(hits[0].matched).toBe(entry.secret);
    expect(text.slice(0, hits[0].start)).toBe(text.slice(0, text.indexOf(entry.secret)));
    expect(text.slice(hits[0].end)).toBe(text.slice(text.indexOf(entry.secret) + entry.secret.length));
  });

  it("matches a private key block from header to footer, and leaves the text around it alone", () => {
    const header = j("-----BEGIN RSA PRIV", "ATE KEY-----");
    const footer = j("-----END RSA PRIV", "ATE KEY-----");
    const block = [header, body(64), body(64, 5), body(40, 9), footer].join("\n");
    const text = `Loaded key:\n${block}\nkey loaded`;
    const hits = ofType(text, "private_key");
    expect(hits).toHaveLength(1);
    expect(hits[0].matched).toBe(block);
  });

  it("matches a private key block with CRLF line breaks, other key kinds, and two blocks", () => {
    const wrap = (kind: string, eol: string) => [j(`-----BEGIN ${kind} PRIV`, "ATE KEY-----"), body(64), j(`-----END ${kind} PRIV`, "ATE KEY-----")].join(eol);
    expect(ofType(`x\r\n${wrap("EC", "\r\n")}\r\ny`, "private_key")).toHaveLength(1);
    for (const kind of ["OPENSSH", "ENCRYPTED", "DSA", ""]) {
      expect(ofType(wrap(kind, "\n").replace("BEGIN  ", "BEGIN "), "private_key"), kind).toHaveLength(1);
    }
    expect(ofType(`${wrap("RSA", "\n")}\nmiddle\n${wrap("EC", "\n")}`, "private_key")).toHaveLength(2);
  });

  it("matches a block that is cut off before its footer, to the end of the text", () => {
    const header = j("-----BEGIN RSA PRIV", "ATE KEY-----");
    const cut = `${header}\n${body(64)}\n${body(30, 3)}`;
    const hits = ofType(`start\n${cut}`, "private_key");
    expect(hits).toHaveLength(1);
    expect(hits[0].matched).toBe(cut);
    expect(ofType(header, "private_key")).toHaveLength(1);
  });

  it("matches the whole Slack webhook URL, host included", () => {
    const url = j("https://hooks.slack", ".com/services/T", "01ABCDEFG", "/B", "01ABCDEFGHI", "/", body(24));
    expect(ofType(`curl ${url}`, "slack_webhook")[0].matched).toBe(url);
  });

  it("matches only the password of a URL with credentials, and only the key of an Azure connection string", () => {
    expect(ofType("postgres://svc:Tr0ub4dor@db.example:5432/x", "basic_auth_url")[0].matched).toBe("Tr0ub4dor");
    const key = j(body(86), "==");
    expect(ofType(`AccountKey=${key};x=1`, "azure_storage_key")[0].matched).toBe(key);
  });

  it("matches only the token after Bearer", () => {
    const token = body(40);
    const hit = ofType(`Authorization: Bearer ${token}`, "bearer_token")[0];
    expect(hit.matched).toBe(token);
  });
});

const NEGATIVE: Array<{ type: string; text: string }> = [
  { type: "aws_access_key", text: j("AKIA", "short") },
  { type: "aws_access_key", text: j("AKIA", "zxq4mn7plkd2rt9w") },
  { type: "github_token", text: j("ghp", "_", "abcde") },
  { type: "github_token", text: j("ghx", "_", body(36)) },
  { type: "github_fine_grained", text: j("github", "_pat_", body(10)) },
  { type: "openai_key", text: j("sk", "-", "short") },
  { type: "openai_key", text: j("sk", "-ant-api03-", urlsafe(95)) },
  { type: "anthropic_key", text: j("sk", "-", body(48)) },
  { type: "stripe_key", text: j("pk", "_live_", body(24)) },
  { type: "stripe_key", text: j("sk", "_live_", "abcde") },
  { type: "slack_token", text: j("xoxz", "-", "123456789012-abcdef") },
  { type: "slack_webhook", text: "https://hooks.slack.com/services/" },
  { type: "google_api_key", text: j("AIza", body(10)) },
  { type: "google_oauth", text: j("ya29", ".short") },
  { type: "twilio_key", text: j("SK", "0123456789abcdef") },
  { type: "sendgrid_key", text: "SG.short.short" },
  { type: "npm_token", text: j("npm", "_", "short") },
  { type: "huggingface_token", text: j("hf", "_model_name") },
  { type: "gitlab_token", text: j("glpat", "-short") },
  { type: "telegram_bot_token", text: "12:34:56 started" },
  { type: "telegram_bot_token", text: j("123456789", ":", body(10)) },
  { type: "azure_storage_key", text: "AccountKey=short" },
  { type: "jwt", text: "eyJabc.def" },
  { type: "jwt", text: "version 1.2.3 build 4.5.6" },
  { type: "bearer_token", text: "Bearer token" },
  { type: "bearer_token", text: "Authorization: Bearer ${TOKEN}" },
  { type: "bearer_token", text: "Authorization: Bearer <token>" },
  { type: "bearer_token", text: "Authorization: Bearer ***" },
  { type: "bearer_token", text: "Bearer abc123" },
  { type: "basic_auth_url", text: "https://example.com/path" },
  { type: "basic_auth_url", text: "https://user@example.com/" },
  { type: "basic_auth_url", text: "http://localhost:3000/a" },
  { type: "basic_auth_url", text: "https://example.com:8080/path?email=a@b.c" },
  { type: "private_key", text: j("-----BEGIN PUB", "LIC KEY-----\n", body(64), "\n-----END PUB", "LIC KEY-----") },
  { type: "ac_api_key", text: "ac_live_" },
  { type: "ac_api_key", text: "ac_live_short" },
  { type: "email", text: "@handle" },
  { type: "email", text: "user@" },
  { type: "email", text: "a@b" },
  { type: "email", text: "mention @everyone in chat" },
  { type: "phone", text: "1.2.3.4" },
  { type: "phone", text: "2026-10-24" },
  { type: "phone", text: "12345678" },
  { type: "phone", text: "version 10.0.19045" },
  { type: "phone", text: "192.168.1.15" },
  { type: "phone", text: "1729761234" },
  { type: "phone", text: "1729761234567" },
  { type: "phone", text: "555-0100" },
  { type: "phone", text: "Date: Fri Oct 23 18:02:11 2026 +0000" },
  { type: "card", text: "4111111111111112" },
  { type: "card", text: "4155550100" },
  { type: "card", text: "123456789012345678901234" },
  { type: "card", text: "ID 12345678901234567890" },
  { type: "card", text: luhnComplete("172976123456") },
  { type: "card", text: "elapsed=1729761234567 ms" },
  { type: "ssn", text: "000-12-3456" },
  { type: "ssn", text: "666-12-3456" },
  { type: "ssn", text: "123-00-4567" },
  { type: "ssn", text: "123-45-0000" },
  { type: "ssn", text: "123-45-67890" },
  { type: "ssn", text: "415-555-0100" },
];

describe("pattern catalogue: look-alikes that are not secrets", () => {
  it.each(NEGATIVE.map((n) => [n.type, n.text.slice(0, 40), n] as const))("%s is not matched in %j", (_type, _label, entry) => {
    expect(ofType(entry.text, entry.type)).toEqual([]);
  });

  it("does not match example-domain addresses, which are clearly fake", () => {
    for (const address of ["a@example.com", "dev@example.org", "x@y.test", "me@host.invalid", "a@foo.example", "qa@mail.example.com"]) {
      expect(ofType(`mail ${address} now`, "email"), address).toEqual([]);
    }
  });
});

describe("luhnValid", () => {
  it.each(["4111111111111111", "378282246310005", "4222222222222", "5555555555554444", "6799990100000000019"])("accepts %s", (digits) => {
    expect(luhnValid(digits)).toBe(true);
  });
  it.each(["4111111111111112", "", "abc", "4111 1111 1111 1111", "0000000000000001"])("rejects %j", (digits) => {
    expect(luhnValid(digits)).toBe(false);
  });
});

describe("email domains", () => {
  it("lists the reserved example domains", () => {
    for (const domain of ["example.com", "example.org", "example.net", "localhost"]) expect(EMAIL_ALLOWED_DOMAINS).toContain(domain);
  });
  it.each(["example.com", "EXAMPLE.COM", "mail.example.com", "foo.example", "x.test", "x.invalid", "x.localhost", "localhost"])("allows %s", (domain) => {
    expect(isAllowedEmailDomain(domain)).toBe(true);
  });
  it.each(["company.io", "notexample.com", "example.com.evil.io", "example.co", "testing.com"])("does not allow %s", (domain) => {
    expect(isAllowedEmailDomain(domain)).toBe(false);
  });
});

describe("pattern catalogue against the corpora", () => {
  // These two are caught by context and entropy rules in the redaction engine, not by a fixed format.
  const NOT_A_FIXED_FORMAT = new Set(["twilio-b", "azure-b"]);
  const catalogued = new Set(TYPES);

  it("matches every catalogued secret in the corpus with its own type, after normalization", () => {
    for (const entry of loadSecrets()) {
      if (!catalogued.has(entry.type) || NOT_A_FIXED_FORMAT.has(entry.id)) continue;
      const text = normalizeText(entry.text).text;
      const secret = normalizeText(entry.secret).text;
      const covered = ofType(text, entry.type).some((hit) => hit.matched.includes(secret) || secret.includes(hit.matched));
      expect(covered, `${entry.id} (${entry.type})`).toBe(true);
    }
  });

  it("matches nothing in any clean trace", () => {
    for (const entry of loadClean()) {
      const hits = findAll(normalizeText(entry.text).text);
      expect(hits.map((hit) => hit.type), entry.id).toEqual([]);
    }
  });
});

describe("pattern catalogue: speed on hostile input", () => {
  const BIG = 32_000;
  const inputs: Array<[string, string]> = [
    ["a", "a".repeat(BIG)],
    ["1", "1".repeat(BIG)],
    ["=", "=".repeat(BIG)],
    ["-", "-".repeat(BIG)],
    ["A-", "A-".repeat(BIG / 2)],
    ["@", "@".repeat(BIG)],
    ["a@", "a@".repeat(BIG / 2)],
    ["ac_live_", "ac_live_".repeat(BIG / 8)],
    ["Bearer ", "Bearer ".repeat(BIG / 7)],
    ["://", "://".repeat(BIG / 3)],
    ["x://y:", "x://y:".repeat(BIG / 6)],
    ["eyJ.eyJ.", "eyJ.eyJ.".repeat(BIG / 8)],
    ["1 ", "1 ".repeat(BIG / 2)],
    ["1-", "1-".repeat(BIG / 2)],
    ["(1", "(1".repeat(BIG / 2)],
    ["+1", "+1".repeat(BIG / 2)],
    ["private key header", "-----BEGIN PRIVATE KEY-----".repeat(Math.floor(BIG / 27))],
    ["AccountKey=", "AccountKey=".repeat(BIG / 11)],
    ["sk-", "sk-".repeat(BIG / 3)],
    ["digits and dots", "123.456.789.".repeat(BIG / 12)],
  ];

  it.each(inputs)("scans 32,000 characters of %j within 500 ms", (_label, text) => {
    const start = Date.now();
    findAll(text);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
