import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedactForm } from "@/components/admin/RedactForm";

vi.mock("@/lib/auth/requireAdmin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/app/admin/actions", () => ({ moderateFormAction: vi.fn(), reportFormAction: vi.fn(), decideReviewFormAction: vi.fn(), redactFormAction: vi.fn() }));

import RedactPage from "@/app/admin/redact/page";
import * as requireAdminModule from "@/lib/auth/requireAdmin";

const requireAdmin = vi.mocked(requireAdminModule.requireAdmin);

const HOSTILE = '<script>alert(1)</script><img src=x onerror="alert(1)">';
const ADMIN = { id: "00000000-0000-4000-8000-000000000900", displayName: "Admin Ada", email: "ada@example.com" } as never;

const withoutReactScript = (markup: string) => markup.replace(/<script>addEventListener\("submit"[\s\S]*?<\/script>/, "");
const render = (ui: ReactNode) => withoutReactScript(renderToStaticMarkup(ui));
const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
const noop = vi.fn();

beforeEach(() => requireAdmin.mockResolvedValue(ADMIN));
afterEach(() => vi.clearAllMocks());

describe("RedactForm", () => {
  const view = () => render(<RedactForm action={noop} />);

  it("has a kind, an id, a field, a fragment and a blank box, and no hidden field", () => {
    const markup = view();
    expect(markup).toMatch(/<select[^>]*name="targetType"/);
    expect(markup).toMatch(/<input[^>]*name="targetId"/);
    expect(markup).toMatch(/<select[^>]*name="field"/);
    expect(markup).toMatch(/<textarea[^>]*name="fragment"/);
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*name="blank"[^>]*value="on"|<input[^>]*name="blank"[^>]*type="checkbox"[^>]*value="on"/);
    expect(markup).not.toMatch(/type="hidden"/);
  });

  it("offers exactly the three kinds and the seven fields", () => {
    const markup = view();
    const values = (name: string) => [...(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(markup)?.[1] ?? "").matchAll(/<option[^>]*value="([^"]*)"/g)].map((match) => match[1]);
    expect(values("targetType")).toEqual(["case", "evidence", "argument"]);
    expect(values("field")).toEqual(["title", "summary", "expected", "actual", "text", "reasoning", "proposedChange"]);
  });

  it("says in fixed words what happens and that it cannot be undone", () => {
    const body = text(view());
    expect(body).toContain("The removed text is replaced with [REDACTED:admin]. This cannot be undone.");
    expect(body).toContain("To blank the whole field, leave the fragment empty and tick the box.");
  });

  it("has a submit button", () => {
    expect(view()).toMatch(/<button[^>]*type="submit"[^>]*>REDACT/);
  });
});

describe("the redact page", () => {
  const page = async (search: { error?: string; done?: string } = {}) => render(await RedactPage({ searchParams: Promise.resolve(search) }));

  it("checks the admin first", async () => {
    await page();
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_NOT_FOUND"));
    await expect(page()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows the form under a fixed heading", async () => {
    const markup = await page();
    expect(text(markup)).toContain("REDACT");
    expect(markup).toContain('name="fragment"');
  });

  it("says how many characters were removed, for a number only", async () => {
    expect(text(await page({ done: "12" }))).toContain("Redaction applied: 12 characters removed.");
    expect(text(await page({ done: "1" }))).toContain("Redaction applied: 1 character removed.");
    for (const bad of [HOSTILE, "12abc", "-5", "1".repeat(9), ""]) {
      const markup = await page({ done: bad });
      expect(text(markup)).not.toContain("Redaction applied");
      expect(markup).not.toContain("alert(1)");
    }
  });

  it("shows a fixed message for an error code and never echoes an unknown one", async () => {
    expect(text(await page({ error: "nothing_to_redact" }))).toContain("ERR_NOTHING_TO_REDACT");
    const hostile = await page({ error: HOSTILE });
    expect(text(hostile)).toContain("ERR_UNEXPECTED_ERROR");
    expect(hostile).not.toContain("alert(1)");
  });

  it("shows no admin id and no email", async () => {
    const markup = await page();
    expect(markup).not.toContain("ada@example.com");
    expect(markup).not.toContain("00000000-0000-4000-8000-000000000900");
  });
});

describe("redaction is guarded where it is built", () => {
  const read = (file: string) => readFileSync(file, "utf8");
  const withoutImports = (source: string) => source.replace(/^import[\s\S]*?;\n/gm, "");

  it("the page calls requireAdmin", () => {
    expect(withoutImports(read("app/admin/redact/page.tsx"))).toMatch(/await requireAdmin\(\)/);
  });

  it("the core checks the origin, then the admin, then calls the service", () => {
    const source = withoutImports(read("lib/admin/redactCore.ts"));
    const body = source.slice(source.indexOf("export async function redactCore"));
    expect(body.indexOf("assertSameOrigin(")).toBeGreaterThan(-1);
    expect(body.indexOf("assertSameOrigin(")).toBeLessThan(body.indexOf("isActiveAdmin("));
    expect(body.indexOf("isActiveAdmin(")).toBeLessThan(body.indexOf("applyRedaction("));
  });

  it("the server action file calls the core and not the service", () => {
    const source = withoutImports(read("app/admin/actions.ts"));
    expect(source).toContain("redactCore(");
    expect(source).not.toMatch(/\bapplyRedaction\(/);
  });

  it("only the redaction service writes the placeholder into stored text", () => {
    expect(read("lib/services/redactionService.ts")).toContain("[REDACTED:admin]");
  });
});
