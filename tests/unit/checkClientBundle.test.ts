import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBundle, collectSecrets, findLeaks } from "@/scripts/check-client-bundle";

const CANARY = "canary-database-password-0123456789";
const APP_PASSWORD = "pw-app-secret-123456";
const OWNER_PASSWORD = "pw-owner-secret-654321";

const env = {
  DATABASE_URL: `postgresql://app:${APP_PASSWORD}@pooled.example.test/neondb?sslmode=require`,
  DATABASE_URL_DIRECT: `postgresql://owner:${OWNER_PASSWORD}@direct.example.test/neondb`,
  BETTER_AUTH_SECRET: "s3cr3t-value-".repeat(4),
  GITHUB_CLIENT_SECRET: "gh-client-secret-value-0123456789",
  GITHUB_CLIENT_ID: "Ov23liExampleClientId",
  NEXT_PUBLIC_SITE_NAME: "a-long-public-site-name-value",
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "bundle-check-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<string> {
  const full = path.join(dir, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  return full;
}

describe("findLeaks", () => {
  it("returns the path of a file that contains a secret", async () => {
    const leaking = await write("chunks/app.js", `var key = "${CANARY}";`);
    await write("chunks/clean.js", "var ok = 1;");
    expect(await findLeaks(dir, [CANARY])).toEqual([leaking]);
  });

  it("searches nested folders and every kind of text asset", async () => {
    const files = await Promise.all(
      ["a/b/c/deep.js", "page.html", "styles.css", "app.js.map", "data.json"].map((name) =>
        write(name, `before ${CANARY} after`),
      ),
    );
    expect((await findLeaks(dir, [CANARY])).sort()).toEqual([...files].sort());
  });

  it("returns nothing for a clean build", async () => {
    await write("chunks/app.js", "var ok = 1;");
    expect(await findLeaks(dir, [CANARY])).toEqual([]);
  });

  it("returns nothing for an empty folder", async () => {
    expect(await findLeaks(dir, [CANARY])).toEqual([]);
  });

  it("ignores secrets shorter than 12 characters", async () => {
    await write("chunks/app.js", "var short = 'tiny-secret';");
    expect(await findLeaks(dir, ["tiny-secret"])).toEqual([]);
  });

  it("does not match a near-miss", async () => {
    await write("chunks/app.js", `var x = "${CANARY.slice(0, -1)}";`);
    expect(await findLeaks(dir, [CANARY])).toEqual([]);
  });

  it("reports a file once even when it holds several secrets", async () => {
    const leaking = await write("chunks/app.js", `${CANARY} and another-secret-value-9999`);
    expect(await findLeaks(dir, [CANARY, "another-secret-value-9999"])).toEqual([leaking]);
  });

  it("rejects when the folder does not exist", async () => {
    await expect(findLeaks(path.join(dir, "missing"), [CANARY])).rejects.toThrow();
  });
});

describe("collectSecrets", () => {
  it("includes the four server secrets", () => {
    const secrets = collectSecrets(env);
    for (const name of ["DATABASE_URL", "DATABASE_URL_DIRECT", "BETTER_AUTH_SECRET", "GITHUB_CLIENT_SECRET"] as const) {
      expect(secrets).toContain(env[name]);
    }
  });

  it("includes the password from each database URL on its own", () => {
    const secrets = collectSecrets(env);
    expect(secrets).toContain(APP_PASSWORD);
    expect(secrets).toContain(OWNER_PASSWORD);
  });

  it("leaves out public values and unrelated variables", () => {
    const secrets = collectSecrets(env);
    expect(secrets).not.toContain(env.GITHUB_CLIENT_ID);
    expect(secrets).not.toContain(env.NEXT_PUBLIC_SITE_NAME);
  });

  it("skips missing and short values", () => {
    expect(collectSecrets({ DATABASE_URL: undefined, BETTER_AUTH_SECRET: "short", GITHUB_CLIENT_SECRET: "" })).toEqual([]);
  });

  it("copes with a database URL that is not a valid URL", () => {
    expect(() => collectSecrets({ DATABASE_URL: "not-a-url-but-long-enough" })).not.toThrow();
  });
});

describe("checkBundle", () => {
  it("passes a clean build", async () => {
    await write("chunks/app.js", "var ok = 1;");
    const result = await checkBundle(dir, env);
    expect(result.ok).toBe(true);
  });

  it("fails when no secrets are configured, instead of passing vacuously", async () => {
    await write("chunks/app.js", "var ok = 1;");
    const result = await checkBundle(dir, {});
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no secrets/i);
  });

  it("fails when the build output is missing", async () => {
    const result = await checkBundle(path.join(dir, "missing"), env);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not found/i);
  });

  it("fails and names the leaking file, without printing the secret", async () => {
    await write("chunks/app.js", `fetch("${env.DATABASE_URL}")`);
    const result = await checkBundle(dir, env);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("app.js");
    expect(result.message).not.toContain(APP_PASSWORD);
    expect(result.message).not.toContain(env.DATABASE_URL);
  });

  it("catches a bare password even when the full URL is absent", async () => {
    await write("chunks/app.js", `var p = "${OWNER_PASSWORD}";`);
    const result = await checkBundle(dir, env);
    expect(result.ok).toBe(false);
  });
});
describe("Upstash token", () => {
  const token = "upstash-token-value-0123456789abcdef";

  it("is collected as a secret", () => {
    expect(collectSecrets({ ...env, UPSTASH_REDIS_REST_TOKEN: token })).toContain(token);
  });

  it("is caught when it appears in the client bundle", async () => {
    await write("chunks/app.js", `fetch("https://x", { headers: { authorization: "Bearer ${token}" } })`);
    const result = await checkBundle(dir, { ...env, UPSTASH_REDIS_REST_TOKEN: token });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(token);
  });
});
