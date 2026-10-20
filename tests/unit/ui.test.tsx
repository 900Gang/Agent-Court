import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Bar } from "@/components/ui/Bar";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { ErrorBlock } from "@/components/ui/ErrorBlock";
import { Notice } from "@/components/ui/Notice";
import { Panel } from "@/components/ui/Panel";
import { WindowFrame } from "@/components/ui/WindowFrame";

const html = renderToStaticMarkup;

describe("Bar", () => {
  it("shows the label and the display text, with progressbar semantics", () => {
    const markup = html(<Bar label="AGENTS" value={2} max={5} display="2 / 5" />);
    expect(markup).toContain("AGENTS");
    expect(markup).toContain("2 / 5");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="2"');
    expect(markup).toContain('aria-valuemin="0"');
    expect(markup).toContain('aria-valuemax="5"');
    expect(markup).toContain('aria-label="AGENTS"');
    expect(markup).toContain("width:40%");
  });

  it("defaults the display text to value / max", () => {
    expect(html(<Bar label="KEYS" value={3} max={15} />)).toContain("3 / 15");
  });

  it("rounds the width to a whole percent", () => {
    expect(html(<Bar label="X" value={1} max={3} />)).toContain("width:33%");
  });

  it.each([
    ["a value above max", 9, 5, "width:100%", 'aria-valuenow="5"'],
    ["a negative value", -4, 5, "width:0%", 'aria-valuenow="0"'],
    ["a max of zero", 3, 0, "width:0%", 'aria-valuenow="0"'],
    ["a value that is not a number", Number.NaN, 5, "width:0%", 'aria-valuenow="0"'],
  ])("clamps %s", (_label, value, max, width, now) => {
    const markup = html(<Bar label="X" value={value} max={max} />);
    expect(markup).toContain(width);
    expect(markup).toContain(now);
  });
});

describe("Chip", () => {
  it.each(["ok", "warn", "off"] as const)("renders the %s variant", (variant) => {
    const markup = html(<Chip variant={variant}>ACTIVE</Chip>);
    expect(markup).toContain("chip");
    expect(markup).toContain(`chip-${variant}`);
    expect(markup).toContain("ACTIVE");
  });
});

describe("ErrorBlock", () => {
  it("is an alert that shows an ERR_ code, the message and the hint", () => {
    const markup = html(<ErrorBlock code="rate_limited" message="Too many requests." hint="Retry in 42 seconds." />);
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("ERR_RATE_LIMITED");
    expect(markup).toContain("Too many requests.");
    expect(markup).toContain("Retry in 42 seconds.");
  });

  it("leaves out the hint when there is none", () => {
    const markup = html(<ErrorBlock code="key_revoked" message="Revoked." />);
    expect(markup).toContain("ERR_KEY_REVOKED");
    expect(markup).not.toContain("err-hint");
  });

  it("renders markup in the message and hint as text", () => {
    const markup = html(<ErrorBlock code="x" message="<script>alert(1)</script>" hint="<img src=x onerror=1>" />);
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;");
  });
});

describe("Notice", () => {
  it("is a status message that renders its children", () => {
    const markup = html(<Notice>This agent is new.</Notice>);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("This agent is new.");
  });
});

describe("Panel", () => {
  it("renders a heading and its children", () => {
    const markup = html(
      <Panel title="CONTROL PANEL">
        <p>inside</p>
      </Panel>,
    );
    expect(markup).toMatch(/<h2[^>]*>CONTROL PANEL<\/h2>/);
    expect(markup).toContain("<p>inside</p>");
  });

  it("has no heading without a title", () => {
    expect(html(<Panel>just content</Panel>)).not.toContain("<h2");
  });
});

describe("WindowFrame", () => {
  it("shows the title with a prompt and decorative window controls", () => {
    const markup = html(
      <WindowFrame title="AGENT-COURT / OPERATOR CONSOLE">
        <p>body</p>
      </WindowFrame>,
    );
    expect(markup).toContain("&gt; AGENT-COURT / OPERATOR CONSOLE");
    expect(markup).toMatch(/aria-hidden="true"[^>]*>_ □ ×/);
    expect(markup).toContain("<p>body</p>");
  });
});

describe("Button", () => {
  it("is type=button by default, so it never submits a form by accident", () => {
    expect(html(<Button>GO</Button>)).toContain('type="button"');
  });

  it("can be a submit button", () => {
    expect(html(<Button type="submit">GO</Button>)).toContain('type="submit"');
  });

  it("renders the outline and solid variants", () => {
    expect(html(<Button>GO</Button>)).toContain("btn");
    expect(html(<Button>GO</Button>)).not.toContain("btn-solid");
    expect(html(<Button variant="solid">GO</Button>)).toContain("btn-solid");
  });

  it("passes disabled and extra class names through", () => {
    const markup = html(
      <Button disabled className="extra">
        GO
      </Button>,
    );
    expect(markup).toContain("disabled");
    expect(markup).toContain("extra");
  });
});

describe("Sidebar", () => {
  it("shows the brand, the operator and a labelled navigation", () => {
    const markup = html(<Sidebar current="agents" operatorName="Ada" />);
    expect(markup).toContain("AGENT-COURT");
    expect(markup).toContain("Ada");
    expect(markup).toContain("ACTIVE OPERATOR");
    expect(markup).toContain('aria-label="Dashboard"');
    expect(markup).toContain('aria-hidden="true"'); // the skull emblem is decorative
  });

  it("marks the current page and links to it", () => {
    const markup = html(<Sidebar current="agents" operatorName="Ada" />);
    expect(markup).toMatch(/<a[^>]*aria-current="page"[^>]*>AGENTS/);
    expect(markup).toMatch(/<a[^>]*href="\/dashboard"[^>]*>AGENTS/);
  });

  it("shows the later pages as disabled items with no link", () => {
    const markup = html(<Sidebar current="agents" operatorName="Ada" />);
    for (const label of ["MY CASES", "VERDICTS", "REPUTATION"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).toContain("SOON");
    expect(markup).not.toMatch(/href="[^"]*(cases|verdicts|reputation)/);
  });

  it("renders the operator name as text", () => {
    const markup = html(<Sidebar current="agents" operatorName="<script>alert(1)</script>" />);
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});

describe("component source", () => {
  it("never uses dangerouslySetInnerHTML", () => {
    for (const folder of ["components/ui", "components/dashboard"]) {
      for (const file of readdirSync(folder).filter((name) => name.endsWith(".tsx"))) {
        const source = readFileSync(path.join(folder, file), "utf8");
        expect(source, `${folder}/${file}`).not.toContain("dangerouslySetInnerHTML");
      }
    }
  });
});
