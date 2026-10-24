import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type CorpusSet = "dev" | "holdout";
export type InjectionField = "prose" | "evidence_prompt" | "evidence_trace";

export type SecretCase = {
  id: string;
  type: string;
  set: CorpusSet;
  /** The sensitive value in plain ASCII. It must be gone from the gate's output. */
  secret: string;
  /** The text to screen. May hold the secret written with hidden or fullwidth characters. */
  text: string;
  /** Placeholder types that count as correct (the entry's own type unless the entry says more). */
  accepts: string[];
  evasion?: string;
  /** Literal non-secret strings that must survive redaction. */
  keep: string[];
};

export type InjectionCase = {
  id: string;
  family: string;
  set: CorpusSet;
  field: InjectionField;
  text: string;
  expect: "flag" | "block";
};

export type CleanCase = {
  id: string;
  set: CorpusSet;
  field: InjectionField | "evidence_other";
  text: string;
  lang: string;
  nearMiss: boolean;
  allowAltered: boolean;
  note?: string;
};

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");

function readJson(name: string): unknown[] {
  const raw = readFileSync(path.join(dir, name), "utf8").trim();
  return raw === "" ? [] : (JSON.parse(raw) as unknown[]);
}

// ASCII 0x21 to 0x7E map onto the fullwidth forms 0xFF01 to 0xFF5E; NFKC maps them back.
const toFullwidth = (value: string) =>
  value.replace(/[\u0021-\u007e]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));

type RawSecret = {
  id: string;
  type: string;
  set: CorpusSet;
  parts: string[];
  template: string;
  accepts?: string[];
  evasion?: string;
  hidden?: "zero_width";
  fullwidth?: boolean;
  keep?: string[];
};

/**
 * Secrets are stored as short parts and joined here, so no complete secret is ever written in the repository
 * (the repository is public and GitHub secret scanning would flag real-looking tokens).
 */
export function loadSecrets(): SecretCase[] {
  return (readJson("secrets.json") as RawSecret[]).map((raw) => {
    const secret = raw.parts.join("");
    let inserted = raw.hidden === "zero_width" ? raw.parts.join("\u200b") : secret;
    if (raw.fullwidth) inserted = toFullwidth(inserted);
    if (raw.template.split("{{SECRET}}").length !== 2) throw new Error(`${raw.id}: template needs one {{SECRET}}`);
    return {
      id: raw.id,
      type: raw.type,
      set: raw.set,
      secret,
      text: raw.template.replace("{{SECRET}}", () => inserted),
      accepts: raw.accepts ?? [raw.type],
      evasion: raw.evasion,
      keep: raw.keep ?? [],
    };
  });
}

export function loadInjections(): InjectionCase[] {
  return readJson("injections.json") as InjectionCase[];
}

export function loadClean(): CleanCase[] {
  return (readJson("clean-traces.json") as Array<Partial<CleanCase> & { id: string; set: CorpusSet; field: CleanCase["field"]; text: string }>).map(
    (raw) => ({ lang: "en", nearMiss: false, allowAltered: false, ...raw }),
  );
}
