import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { E2E, HOSTILE } from "./data";

const SCRIPT_TEXT = "<script>alert(1)</script>";

/** Collects what must never happen on a public page: a dialog, a script error or a console error. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("dialog", (dialog) => {
    problems.push(`dialog: ${dialog.type()}`);
    void dialog.dismiss();
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.location().url.endsWith("/favicon.ico")) {
      problems.push(`console: ${message.text()}`);
    }
  });
  return problems;
}

/** The hostile text is on the page as characters, and nothing in the page was made from it. */
async function expectNoElementsFromText(page: Page) {
  const main = page.locator("main");
  await expect(main.locator("script, img, iframe, style")).toHaveCount(0);
  await expect(main.locator("[onerror]")).toHaveCount(0);
}

async function expectNoSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("the home page shows its heading, both lists and the way to sign in", async ({ page }, testInfo) => {
  const problems = watch(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A public court for AI agents");
  await expect(page.getByRole("heading", { level: 2, name: "Recently resolved" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Open cases that need a fix" })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E.resolvedTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E.openTitle })).toBeVisible();
  if (testInfo.project.name === "mobile") await page.getByText("MENU", { exact: true }).click();
  const signIn = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute("href", "/dashboard");
  expect(problems).toEqual([]);
});

test("the menu: closed on a phone until it is opened, open on a wide screen", async ({ page }, testInfo) => {
  await page.goto("/");
  const menu = page.getByText("MENU", { exact: true });
  const search = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Search", exact: true });
  if (testInfo.project.name === "mobile") {
    await expect(menu).toBeVisible();
    await expect(search).toBeHidden();
    await menu.click();
  } else {
    await expect(menu).toBeHidden();
  }
  await expect(search).toBeVisible();
});

test("a resolved case shows its evidence, its argument and its verdict, and a visitor cannot report", async ({ page }) => {
  const problems = watch(page);
  await page.goto(`/cases/${E2E.resolvedCaseId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(E2E.resolvedTitle);
  const main = page.locator("main");
  await expect(main).toContainText(E2E.resolvedEvidence);
  await expect(main).toContainText(E2E.resolvedReasoning);
  await expect(main).toContainText("VERDICT");
  await expect(main).toContainText("OPERATOR-CONFIRMED");
  await expect(main).toContainText(E2E.verdictNote);
  await expect(page).toHaveTitle(/^Case [0-9a-f]{8} · Agent-Court$/);
  expect(await page.getByText("Sign in to report").count()).toBeGreaterThan(0);
  await expect(page.locator("form")).toHaveCount(0);
  await expectNoSideScroll(page);
  expect(problems).toEqual([]);
});

test("a hostile case is shown as text and does nothing", async ({ page }) => {
  const problems = watch(page);
  await page.goto(`/cases/${E2E.hostileCaseId}`);
  await expect(page.locator("main")).toContainText(SCRIPT_TEXT);
  await expectNoElementsFromText(page);
  await expect(page).toHaveTitle(/^Case [0-9a-f]{8} · Agent-Court$/);
  await expectNoSideScroll(page);
  expect(problems).toEqual([]);
});

test("agent profiles render, and a hostile profile is shown as text", async ({ page }) => {
  const problems = watch(page);
  await page.goto(`/agents/${E2E.agentHandle}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(E2E.agentHandle);
  await expect(page.locator("main")).toContainText("REPUTATION NOT YET SCORED");
  await page.goto(`/agents/${E2E.hostileAgentHandle}`);
  await expect(page.locator("main")).toContainText(SCRIPT_TEXT);
  await expectNoElementsFromText(page);
  await expectNoSideScroll(page);
  expect(problems).toEqual([]);
});

test("the search page browses, finds a case by keyword, and shows a hostile query as text", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/search");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Search");
  await expect(page.locator("main")).toContainText(E2E.openTitle);

  await page.goto("/search?q=E2E");
  await expect(page.locator("main")).toContainText("Results for");
  await expect(page.locator("main")).toContainText(E2E.resolvedTitle);

  await page.goto(`/search?q=${encodeURIComponent(HOSTILE)}`);
  await expect(page.getByRole("searchbox")).toHaveValue(HOSTILE);
  await expectNoElementsFromText(page);
  expect(problems).toEqual([]);
});

test("an unknown case is the not-found page", async ({ page }) => {
  for (const id of [randomUUID(), "not-a-uuid"]) {
    const response = await page.goto(`/cases/${id}`);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Not found");
  }
});
