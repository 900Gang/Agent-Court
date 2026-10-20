"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { buildSnippets } from "@/lib/dashboard/snippets";

const TABS = [
  { id: "claudeCode", label: "CLAUDE CODE (MCP)" },
  { id: "cursor", label: "CURSOR" },
  { id: ".env", label: ".ENV" },
  { id: "curl", label: "CURL" },
] as const;

const SNIPPET_FOR: Record<(typeof TABS)[number]["id"], "claudeCode" | "cursor" | "env" | "curl"> = {
  claudeCode: "claudeCode",
  cursor: "cursor",
  ".env": "env",
  curl: "curl",
};

const PREFIX_LENGTH = 8; // "ac_live_"

/**
 * The one-time view of a new key. The key lives only in this component's props and state: it is not
 * put in a URL, cookie or storage, and a refresh loses it. DONE stays locked until the operator
 * confirms they copied it, and leaving the page asks for confirmation until then.
 */
export function KeyReveal({
  keyValue,
  fingerprint,
  scopes,
  expiresAt,
  baseUrl,
  onDone,
}: {
  keyValue: string;
  fingerprint: string;
  scopes: string[];
  expiresAt: string | null;
  baseUrl: string;
  onDone: () => void;
}) {
  const [tab, setTab] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const snippets = buildSnippets(keyValue, baseUrl);

  useEffect(() => {
    if (confirmed) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [confirmed]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(keyValue);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="panel reveal" aria-label="New API key">
      <div className="hazard" aria-hidden="true" />
      <p className="warnline">
        ⚠ THIS KEY IS SHOWN ONCE. WE STORE ONLY A HASH. WE CANNOT SHOW IT AGAIN.
      </p>

      <div className="keybox">
        <span className="keytext">
          <span className="key-prefix">{keyValue.slice(0, PREFIX_LENGTH)}</span>
          {keyValue.slice(PREFIX_LENGTH)}
        </span>
        <Button onClick={copy}>{copied ? "COPIED" : "COPY"}</Button>
      </div>

      <div role="tablist" aria-label="Client configuration" className="tabs">
        {TABS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === index}
            id={`tab-${index}`}
            aria-controls="tabpanel"
            className={tab === index ? "tab tab-on" : "tab"}
            onClick={() => setTab(index)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id="tabpanel" aria-labelledby={`tab-${tab}`}>
        <pre className="snippet">{snippets[SNIPPET_FOR[TABS[tab].id]]}</pre>
      </div>

      <dl className="meta">
        <dt>FINGERPRINT</dt>
        <dd>{fingerprint}</dd>
        <dt>SCOPES</dt>
        <dd>{scopes.join(", ")}</dd>
        <dt>EXPIRES</dt>
        <dd>{expiresAt === null ? "NEVER" : expiresAt.slice(0, 10)}</dd>
      </dl>

      <label className="check">
        <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>I have copied this key somewhere safe</span>
      </label>
      <Button variant="solid" disabled={!confirmed} onClick={onDone}>
        DONE
      </Button>
    </section>
  );
}
