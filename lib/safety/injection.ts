import type { FieldKind } from "./limits";
import type { Stripped } from "./normalize";
import { PROMPT_EVIDENCE_WEIGHT } from "./thresholds";

export type InjectionHit = { rule: string; count: number; weight: number };

export type InjectionRule = {
  id: string;
  family: "override" | "role_marker" | "tool_call" | "exfiltration" | "base64";
  weight: 1 | 2 | 3;
  regex: RegExp;
  /** How many matches count at most (default 3). */
  maxCount?: number;
  /** Skip a match that is preceded by a negation ("never reveal ..."). */
  negatable?: boolean;
};

// Between words: one to ten characters that are not word characters, so extra spaces, line breaks and runs of
// punctuation do not hide a phrase. Every quantifier is bounded, so matching stays linear.
const S = String.raw`[^\w]{1,10}`;
const S4 = String.raw`[^\w]{1,4}`;
const SECRET_THING = String.raw`(?:api[^\w]?keys?|tokens?|credentials?|secrets?|passwords?|environment(?:${S4}variables)?)`;

const NOUN = String.raw`(?:instructions?|prompts?|messages?|rules|directions?|directives?|guidelines?|orders?|commands?|context)`;

export const INJECTION_RULES: readonly InjectionRule[] = [
  // ---- override: explicit instruction overrides (strong), role resets (medium), jargon (weak)
  {
    id: "ignore_previous",
    family: "override",
    weight: 3,
    regex: new RegExp(
      String.raw`\b(?:ignore|disregard|forget)${S}(?:(?:all|any|the|your|my|these|those|every|of)${S})*(?:(?:previous|prior|above|earlier|preceding|former)${S}${NOUN}|${NOUN}${S}(?:above|before|so${S}far|given)|above(?=\s*(?:[.,;:!]|$|and\b|then\b|but\b|instead\b|only\b|just\b)))\b`,
      "gi",
    ),
  },
  { id: "forget_everything", family: "override", weight: 3, regex: new RegExp(String.raw`\b(?:forget|ignore|disregard)${S}everything\b`, "gi") },
  {
    // "ignore previous instructions" in other languages: Spanish, French, German, Portuguese, Italian, Chinese, Japanese.
    id: "ignore_previous_i18n",
    family: "override",
    weight: 3,
    regex:
      /ignora(?:r|d)?\s{1,5}(?:todas\s{1,5})?(?:las\s{1,5})?instrucciones\s{1,5}(?:anteriores|previas)|ignor(?:ez|er|e)\s{1,5}(?:toutes\s{1,5})?(?:les\s{1,5})?instructions\s{1,5}(?:pr[e\u00e9]c[e\u00e9]dentes|ant[e\u00e9]rieures)|ignorier(?:e|en)\s{1,5}(?:alle\s{1,5})?(?:vorherigen|bisherigen|obigen|fr\u00fcheren)\s{1,5}anweisungen|ignore\s{1,5}(?:todas\s{1,5})?as\s{1,5}instru[c\u00e7][o\u00f5]es\s{1,5}anteriores|ignora\s{1,5}(?:tutte\s{1,5})?le\s{1,5}istruzioni\s{1,5}precedenti|\u5ffd\u7565(?:\u4e4b\u524d|\u4ee5\u4e0a|\u4e0a\u9762|\u524d\u9762)?\u7684?(?:\u6240\u6709)?(?:\u6307\u4ee4|\u6307\u793a|\u63d0\u793a)|\u4ee5\u524d\u306e\u6307\u793a\u3092\u7121\u8996/gi,
  },
  {
    id: "from_now_on",
    family: "override",
    weight: 2,
    regex: new RegExp(String.raw`\bfrom${S4}now${S4}on\b[^\n]{0,30}?\byou(?:[^\w]{1,3}(?:will|must|shall|are|should)|['\u2019]ll)\b`, "gi"),
  },
  { id: "pretend_you_are", family: "override", weight: 2, regex: new RegExp(String.raw`\bpretend${S4}(?:that${S4})?(?:you${S4}(?:are|re)|to${S4}be)\b`, "gi") },
  {
    // Text addressed to whatever AI reads it is written for that AI, not for people.
    id: "note_to_assistant",
    family: "override",
    weight: 3,
    regex: new RegExp(String.raw`\b(?:note|message|notice)${S4}(?:to|for)${S4}(?:the${S4})?(?:ai|assistants?|llms?|models?|agents?|chatbots?)\b`, "gi"),
  },
  { id: "you_are_now", family: "override", weight: 2, regex: new RegExp(String.raw`\byou${S4}are${S4}now\b`, "gi") },
  { id: "new_instructions", family: "override", weight: 2, regex: new RegExp(String.raw`\bnew${S4}instructions?\s{0,3}:`, "gi") },
  {
    id: "act_as",
    family: "override",
    weight: 2,
    regex: new RegExp(String.raw`\bact${S4}as${S4}(?:(?:an?|the)${S4})?(?:admin(?:istrator)?|system|developer|root|superuser)\b`, "gi"),
  },
  {
    id: "do_not_tell_user",
    family: "override",
    weight: 2,
    regex: /\b(?:do\s+not|don['\u2019]t|never)\s+tell\s+(?:the\s+)?(?:user|human|operator)\b/gi,
  },
  { id: "weak_system_prompt", family: "override", weight: 1, maxCount: 1, regex: new RegExp(String.raw`\bsystem[^\w]{1,3}prompt\b`, "gi") },
  { id: "weak_jailbreak", family: "override", weight: 1, maxCount: 1, regex: /\bjail[^\w]?break(?:s|ed|ing)?\b/gi },
  { id: "weak_developer_mode", family: "override", weight: 1, maxCount: 1, regex: new RegExp(String.raw`\bdeveloper[^\w]{1,3}mode\b`, "gi") },

  // ---- role markers
  { id: "role_line", family: "role_marker", weight: 2, regex: /^[ \t]*(?:system|assistant|human)[ \t]*:/gim },
  { id: "chatml", family: "role_marker", weight: 2, regex: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/gi },
  { id: "llama_markers", family: "role_marker", weight: 2, regex: /\[\/?INST\]|<<\/?SYS>>/gi },
  { id: "instruction_header", family: "role_marker", weight: 2, maxCount: 1, regex: /^#{2,4}[ \t]*instruction\b/gim },
  { id: "system_tag", family: "role_marker", weight: 2, regex: /<system>/gi },

  // ---- tool-call shaped payloads (only opening tags count, so one well-formed call is not a block by itself)
  { id: "tool_function_calls", family: "tool_call", weight: 3, regex: /<function_calls\b/gi },
  { id: "tool_invoke", family: "tool_call", weight: 3, regex: /<invoke\s+name\s*=/gi },
  { id: "tool_calls_json", family: "tool_call", weight: 3, regex: /["']tool_calls["']/gi },
  { id: "tool_use_tag", family: "tool_call", weight: 3, regex: /<tool_use\b/gi },
  { id: "function_call_json", family: "tool_call", weight: 3, regex: /["']function_call["']\s*:/gi },
  {
    id: "call_the_tool",
    family: "tool_call",
    weight: 2,
    regex: new RegExp(String.raw`\bcall${S4}the${S4}(?:tool|function)${S4}[\x60'"]?\w+[\x60'"]?${S4}with\b`, "gi"),
  },

  // ---- exfiltration
  {
    id: "exfil_send_me",
    family: "exfiltration",
    weight: 3,
    regex: new RegExp(String.raw`\bsend${S4}(?:me|us)${S4}(?:your|the)${S4}${SECRET_THING}\b`, "gi"),
  },
  {
    id: "exfil_send_to",
    family: "exfiltration",
    weight: 3,
    regex: new RegExp(
      String.raw`\bsend${S4}(?:your|the)${S4}${SECRET_THING}[^\w]{1,6}to[^\w]{1,4}(?:https?:\/\/\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)+|(?:this|that)\s+(?:url|address|link|endpoint|server|host)|me\b|us\b)`,
      "gi",
    ),
  },
  { id: "exfil_curl_pipe", family: "exfiltration", weight: 3, regex: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/gi },
  { id: "exfil_decode_shell", family: "exfiltration", weight: 3, regex: /\bbase64[^\n|]{0,20}(?:-d|--decode|-D)\b[^\n|]{0,60}\|\s*(?:ba|z)?sh\b/gi },
  {
    id: "exfil_read_secrets",
    family: "exfiltration",
    weight: 3,
    regex: /\bcat\s+\S*(?:\.env(?!\.(?:example|sample|template))\b|id_rsa\b|\.aws\/credentials\b|\.netrc\b|\.npmrc\b|\.pgpass\b)/gi,
  },
  {
    id: "exfil_reveal_prompt",
    family: "exfiltration",
    weight: 3,
    negatable: true,
    regex: new RegExp(
      String.raw`\b(?:reveal${S4}(?:your|the|all|me)${S4}(?:(?:full|entire|hidden|secret)${S4})?(?:system${S4})?(?:prompt|instructions)|(?:print|show|output|repeat|dump|leak|display|translate|summari[sz]e)${S4}(?:me${S4})?your${S4}(?:(?:full|entire)${S4})?(?:(?:hidden|secret|system|initial|original|internal)${S4})?(?:prompt|instructions|rules))\b`,
      "gi",
    ),
  },
  {
    id: "exfil_post_to",
    family: "exfiltration",
    weight: 3,
    regex: new RegExp(String.raw`\bpost${S4}(?:them|it|these|those|the${S4}\w+)${S4}to${S4}https?:\/\/\S+`, "gi"),
  },
  { id: "exfil_pipe_out", family: "exfiltration", weight: 3, regex: /\b(?:printenv|env|history|cat\s+\S+)\s*\|\s*(?:curl|wget|nc|ncat|netcat)\b/gi },
  {
    id: "exfil_repeat_above",
    family: "exfiltration",
    weight: 3,
    negatable: true,
    regex: new RegExp(String.raw`\brepeat${S4}(?:all${S4}(?:of${S4})?)?(?:the${S4})?(?:words|text|content|everything)${S4}above\b`, "gi"),
  },
  {
    id: "exfil_powershell_iex",
    family: "exfiltration",
    weight: 3,
    regex: /\b(?:iex|invoke-expression)\b[^\n]{0,60}?\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|webclient)\b|\|\s*iex\b/gi,
  },

  // ---- hidden payloads
  {
    id: "base64_blob",
    family: "base64",
    weight: 2,
    maxCount: 1,
    regex: /(?<![A-Za-z0-9+/=-])(?<!sha(?:256|384|512)-)[A-Za-z0-9+/]{200,}={0,2}/gi,
  },
  {
    id: "decode_execute",
    family: "base64",
    weight: 2,
    regex:
      /\b(?:decode|decrypt)\b[^\n]{0,60}?\b(?:run|execute|eval|follow|obey)\b|\b(?:run|execute|eval|follow|obey)\b[^\n]{0,30}?\b(?:decoded|decrypted)\b/gi,
  },
];

// ---- look-alike letters that NFKC does not fold (Cyrillic and Greek letters drawn like Latin ones)

// Written as code points so the source file holds no confusable characters itself.
const LOOKALIKE_PAIRS: ReadonlyArray<readonly [number, string]> = [
  // Cyrillic, lower case: a e o p c y x i j s h d q w
  [0x0430, "a"], [0x0435, "e"], [0x043e, "o"], [0x0440, "p"], [0x0441, "c"], [0x0443, "y"], [0x0445, "x"],
  [0x0456, "i"], [0x0458, "j"], [0x0455, "s"], [0x04bb, "h"], [0x0501, "d"], [0x051b, "q"], [0x051d, "w"],
  // Cyrillic, upper case: A B E K M H O P C T X I J S
  [0x0410, "A"], [0x0412, "B"], [0x0415, "E"], [0x041a, "K"], [0x041c, "M"], [0x041d, "H"], [0x041e, "O"],
  [0x0420, "P"], [0x0421, "C"], [0x0422, "T"], [0x0425, "X"], [0x0406, "I"], [0x0408, "J"], [0x0405, "S"],
  // Greek, upper case: A B E Z H I K M N O P T Y X
  [0x0391, "A"], [0x0392, "B"], [0x0395, "E"], [0x0396, "Z"], [0x0397, "H"], [0x0399, "I"], [0x039a, "K"],
  [0x039c, "M"], [0x039d, "N"], [0x039f, "O"], [0x03a1, "P"], [0x03a4, "T"], [0x03a5, "Y"], [0x03a7, "X"],
  // Greek, lower case: o v i k p
  [0x03bf, "o"], [0x03bd, "v"], [0x03b9, "i"], [0x03ba, "k"], [0x03c1, "p"],
];
const LOOKALIKES = new Map(LOOKALIKE_PAIRS.map(([code, latin]) => [String.fromCharCode(code), latin]));
// Greek and Coptic through Cyrillic Supplement.
const LOOKALIKE_PRESENT = /[\u0391-\u03c9\u0400-\u052f]/;
const LOOKALIKE_RUN = /[\u0391-\u03c9\u0400-\u052f]/g;

function foldLookalikes(text: string): string {
  return text.replace(LOOKALIKE_RUN, (char) => LOOKALIKES.get(char) ?? char);
}

// ---- negation: "never reveal your system prompt" is a rule for the assistant, not a request

const NEGATION = /\b(?:never|not|cannot|can['\u2019]t|won['\u2019]t|shall\s+not|refuse\s+to|unable\s+to|n['\u2019]t)\W*(?:\w+\W+){0,2}$/i;

function isNegated(text: string, index: number): boolean {
  return NEGATION.test(text.slice(Math.max(0, index - 30), index));
}

const HALVED_FAMILIES = new Set(["override", "role_marker"]);

/**
 * Adds up signs that text is written to steer a reader or a model: the sum over rules of weight times the
 * number of matches (at most three, or the rule's own limit). Prompt excerpts and traces legitimately contain
 * role markers and "you are" lines, so there the override and role-marker families count at half weight, and
 * role markers count once. Hidden characters removed during normalization add their own hits.
 */
export function scoreInjection(
  text: string,
  options: { kind: FieldKind; stripped?: Stripped },
): { score: number; hits: InjectionHit[] } {
  const folded = LOOKALIKE_PRESENT.test(text) ? foldLookalikes(text) : text;
  const lenient = options.kind === "evidence_prompt" || options.kind === "evidence_trace";
  const hits: InjectionHit[] = [];

  for (const rule of INJECTION_RULES) {
    const halved = lenient && HALVED_FAMILIES.has(rule.family);
    const cap = lenient && rule.family === "role_marker" ? 1 : (rule.maxCount ?? 3);
    let count = 0;
    for (const match of folded.matchAll(rule.regex)) {
      if (rule.negatable && isNegated(folded, match.index as number)) continue;
      count++;
      if (count >= cap) break;
    }
    if (count > 0) hits.push({ rule: rule.id, count, weight: halved ? rule.weight * PROMPT_EVIDENCE_WEIGHT : rule.weight });
  }

  const stripped = options.stripped;
  if (stripped) {
    if (stripped.tag > 0) hits.push({ rule: "hidden_tag", count: 1, weight: 6 });
    if (stripped.bidi > 0) hits.push({ rule: "hidden_bidi", count: 1, weight: 3 });
    if (stripped.zeroWidth >= 5) hits.push({ rule: "hidden_zero_width", count: 1, weight: 1 });
  }

  const score = hits.reduce((total, hit) => total + hit.weight * hit.count, 0);
  return { score, hits };
}
