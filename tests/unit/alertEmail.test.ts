import { describe, expect, it } from "vitest";
import { alertMessage } from "@/emails/alert";
import type { AlertFinding } from "@/lib/alerts/rules";

// N10 Task 5 (AC-1006): an alert email holds the rule, the numbers, route names and one link. Nothing else.

const TO = "ops@example.test";
const BASE = "https://court.example.test";
const FLAG: AlertFinding = { rule: "flag_rate", screened: 20, flagged: 9 };
const RATE: AlertFinding = { rule: "rate_limited", requests: 400, rateLimited: 120 };
const CRON: AlertFinding = { rule: "cron_missed", routes: ["reembed", "rescan"] };

describe("alertMessage", () => {
  it("addresses the alert address and has a subject that names the rule in fixed words", () => {
    expect(alertMessage(FLAG, BASE, TO)).toMatchObject({ to: TO, subject: "Agent-Court alert: flag rate is high" });
    expect(alertMessage(RATE, BASE, TO).subject).toBe("Agent-Court alert: many requests are being refused with 429");
    expect(alertMessage(CRON, BASE, TO).subject).toBe("Agent-Court alert: a scheduled route has stopped");
  });

  it("states the numbers of the flag-rate rule", () => {
    const { text } = alertMessage(FLAG, BASE, TO);
    expect(text).toContain("9 of 20");
    expect(text).toContain("45%");
  });

  it("states the numbers of the 429 rule", () => {
    const { text } = alertMessage(RATE, BASE, TO);
    expect(text).toContain("120 of 400");
    expect(text).toContain("30%");
  });

  it("names the routes of the missed-cron rule", () => {
    expect(alertMessage(CRON, BASE, TO).text).toContain("reembed, rescan");
  });

  it("has one link, to the metrics page, even when the site address ends with a slash", () => {
    for (const base of [BASE, `${BASE}/`, `${BASE}//`]) {
      const { html, text } = alertMessage(FLAG, base, TO);
      expect(html.match(/href="/g)).toHaveLength(1);
      expect(html).toContain('href="https://court.example.test/admin/metrics"');
      expect(text).toContain("https://court.example.test/admin/metrics");
    }
  });

  it("is a plain document: no script, no image, no style, no form", () => {
    const { html } = alertMessage(CRON, BASE, TO);
    for (const tag of ["<script", "<img", "<style", "<form", "<iframe"]) expect(html).not.toContain(tag);
  });

  it("escapes everything it prints, so a route name could never become markup", () => {
    const hostile: AlertFinding = { rule: "cron_missed", routes: ['<script>alert(1)</script>"x"'] };
    const { html } = alertMessage(hostile, BASE, TO);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("says why the reader is getting it, in one fixed sentence", () => {
    expect(alertMessage(FLAG, BASE, TO).text).toContain("alert address of this Agent-Court deployment");
  });
});
