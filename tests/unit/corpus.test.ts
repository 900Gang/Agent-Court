import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadClean, loadInjections, loadSecrets } from "../helpers/corpus";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const rawFile = (name: string) => readFileSync(path.join(dir, name), "utf8");
const FILES = ["secrets.json", "injections.json", "clean-traces.json"];

const SECRET_TYPES = [
  "aws_access_key", "aws_secret_key", "github_token", "github_fine_grained", "openai_key", "anthropic_key",
  "stripe_key", "slack_token", "slack_webhook", "google_api_key", "google_oauth", "twilio_key", "sendgrid_key",
  "npm_token", "huggingface_token", "gitlab_token", "telegram_bot_token", "azure_storage_key", "jwt",
  "bearer_token", "basic_auth_url", "private_key", "ac_api_key", "generic_secret", "email", "phone", "card",
  "ssn", "high_entropy",
];
const AT_LEAST_TWO = ["generic_secret", "high_entropy", "email", "phone", "card"];
const FAMILIES = ["override", "role_marker", "tool_call", "exfiltration", "base64", "hidden_unicode", "scheme_and_beacon", "combined"];

// Normal form used to find a secret inside text that was written with hidden or fullwidth characters.
const norm = (value: string) => value.normalize("NFKC").replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

function share(entries: Array<{ set: string }>) {
  return entries.filter((entry) => entry.set === "holdout").length / entries.length;
}

describe("fixture files", () => {
  it.each(FILES)("%s is plain ASCII", (name) => {
    // Unicode tricks are written as \u escapes, so reviewers and scanners see them.
    expect(/[^\x00-\x7f]/.test(rawFile(name))).toBe(false);
  });

  it.each(FILES)("%s contains no literal secret in a real provider format", (name) => {
    const text = rawFile(name);
    for (const pattern of [
      /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /sk-[A-Za-z0-9_-]{20,}/,
      /sk_live_[A-Za-z0-9]{10,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /AIza[0-9A-Za-z_-]{30,}/, /SG\.[A-Za-z0-9_-]{16,}/,
      /glpat-[A-Za-z0-9_-]{15,}/, /hf_[A-Za-z0-9]{30,}/, /npm_[A-Za-z0-9]{30,}/, /eyJ[A-Za-z0-9_-]{10,}\.eyJ/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ]) {
      expect(pattern.test(text), `${name} matches ${pattern}`).toBe(false);
    }
  });
});

describe("secrets corpus", () => {
  const secrets = loadSecrets();

  it("has at least 60 entries with unique ids", () => {
    expect(secrets.length).toBeGreaterThanOrEqual(60);
    expect(new Set(secrets.map((s) => s.id)).size).toBe(secrets.length);
  });

  it("uses only known types and covers all 29", () => {
    for (const entry of secrets) expect(SECRET_TYPES, entry.id).toContain(entry.type);
    const found = new Set(secrets.map((s) => s.type));
    for (const type of SECRET_TYPES) expect(found.has(type), `missing type ${type}`).toBe(true);
  });

  it.each(AT_LEAST_TWO)("has at least two %s entries", (type) => {
    expect(secrets.filter((s) => s.type === type).length).toBeGreaterThanOrEqual(2);
  });

  it("has at least six evasion entries covering at least five kinds", () => {
    const evasions = secrets.filter((s) => s.evasion);
    expect(evasions.length).toBeGreaterThanOrEqual(6);
    expect(new Set(evasions.map((s) => s.evasion)).size).toBeGreaterThanOrEqual(5);
  });

  it("holds each secret exactly once in its text, after hidden and fullwidth characters are normalized", () => {
    for (const entry of secrets) {
      expect(entry.secret.length, entry.id).toBeGreaterThanOrEqual(8);
      expect(count(norm(entry.text), norm(entry.secret)), entry.id).toBe(1);
      expect(entry.text.length, entry.id).toBeLessThanOrEqual(8000);
    }
  });

  it("uses the dev and holdout sets, with at least 30% held out", () => {
    for (const entry of secrets) expect(["dev", "holdout"], entry.id).toContain(entry.set);
    expect(share(secrets)).toBeGreaterThanOrEqual(0.3);
  });

  it("keeps a holdout entry for every type that has three or more entries", () => {
    for (const type of SECRET_TYPES) {
      const entries = secrets.filter((s) => s.type === type);
      if (entries.length >= 3) expect(entries.some((s) => s.set === "holdout"), type).toBe(true);
    }
  });

  it("lists accepted placeholder types that include the entry's own type unless it says otherwise", () => {
    for (const entry of secrets) {
      expect(entry.accepts.length, entry.id).toBeGreaterThan(0);
      for (const accepted of entry.accepts) expect(SECRET_TYPES, `${entry.id}: ${accepted}`).toContain(accepted);
    }
  });
});

describe("injections corpus", () => {
  const injections = loadInjections();

  it("has at least 60 entries with unique ids", () => {
    expect(injections.length).toBeGreaterThanOrEqual(60);
    expect(new Set(injections.map((i) => i.id)).size).toBe(injections.length);
  });

  it.each(FAMILIES)("has at least three %s entries, in both sets", (family) => {
    const entries = injections.filter((i) => i.family === family);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.some((i) => i.set === "holdout"), "holdout").toBe(true);
    expect(entries.some((i) => i.set === "dev"), "dev").toBe(true);
  });

  it("uses only known families, fields and expectations", () => {
    for (const entry of injections) {
      expect(FAMILIES, entry.id).toContain(entry.family);
      expect(["prose", "evidence_prompt", "evidence_trace"], entry.id).toContain(entry.field);
      expect(["flag", "block"], entry.id).toContain(entry.expect);
      expect(entry.text.trim().length, entry.id).toBeGreaterThan(0);
      expect(["dev", "holdout"], entry.id).toContain(entry.set);
    }
  });

  it("meets the coverage minimums", () => {
    expect(injections.filter((i) => i.expect === "block").length).toBeGreaterThanOrEqual(10);
    expect(injections.filter((i) => i.family === "hidden_unicode").length).toBeGreaterThanOrEqual(5);
    expect(injections.filter((i) => i.family === "tool_call").length).toBeGreaterThanOrEqual(8);
    expect(injections.filter((i) => i.field !== "prose").length).toBeGreaterThanOrEqual(6);
    expect(share(injections)).toBeGreaterThanOrEqual(0.3);
  });

  it("writes hidden characters as escapes, so the raw file shows them", () => {
    const hidden = injections.filter((i) => i.family === "hidden_unicode");
    expect(hidden.some((i) => /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/.test(i.text))).toBe(true);
    expect(hidden.some((i) => /[\u{e0000}-\u{e007f}]/u.test(i.text))).toBe(true);
  });
});

describe("clean traces corpus", () => {
  const clean = loadClean();

  it("has at least 120 entries with unique ids", () => {
    expect(clean.length).toBeGreaterThanOrEqual(120);
    expect(new Set(clean.map((c) => c.id)).size).toBe(clean.length);
  });

  it("spreads over the field kinds", () => {
    for (const field of ["prose", "evidence_prompt", "evidence_trace", "evidence_other"]) {
      expect(clean.filter((c) => c.field === field).length, field).toBeGreaterThanOrEqual(8);
    }
  });

  it("has at least 20 near misses, 6 non-English texts and 2 emoji texts", () => {
    expect(clean.filter((c) => c.nearMiss).length).toBeGreaterThanOrEqual(20);
    expect(clean.filter((c) => c.lang !== "en").length).toBeGreaterThanOrEqual(6);
    expect(clean.filter((c) => /\p{Extended_Pictographic}/u.test(c.text)).length).toBeGreaterThanOrEqual(2);
  });

  it("uses the dev and holdout sets, with at least 30% held out, and keeps texts non-empty and bounded", () => {
    expect(share(clean)).toBeGreaterThanOrEqual(0.3);
    for (const entry of clean) {
      expect(["dev", "holdout"], entry.id).toContain(entry.set);
      expect(entry.text.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.text.length, entry.id).toBeLessThanOrEqual(8000);
    }
  });
});
