/**
 * Fixed-format secrets and personal data. Each rule's regex has the `g` flag, and the `d` flag when a capture
 * group is the secret. A match is the capture group `group` when set, else the whole match; `validate` receives
 * that span and returns false to discard it. Every quantifier is bounded or anchored on a literal, so matching
 * is linear even on hostile input.
 */
export type PatternRule = {
  type: string;
  regex: RegExp;
  group?: number;
  validate?: (matched: string) => boolean;
};

/** Luhn check on a string of digits only. Anything else, including separators, is false. */
export function luhnValid(digits: string): boolean {
  if (!/^[0-9]{2,}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Domains that are clearly fake (reserved for examples and tests), so an address there is not personal data. */
export const EMAIL_ALLOWED_DOMAINS: readonly string[] = ["example.com", "example.org", "example.net", "localhost"];
const EMAIL_ALLOWED_TLDS = ["example", "test", "invalid", "localhost"];

export function isAllowedEmailDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  return (
    EMAIL_ALLOWED_DOMAINS.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`)) ||
    EMAIL_ALLOWED_TLDS.some((tld) => lower === tld || lower.endsWith(`.${tld}`))
  );
}

function cardValid(matched: string): boolean {
  const digits = matched.replace(/[ -]/g, "");
  // Card numbers start with 3 to 6 (Amex, Visa, Mastercard, Discover, JCB, Diners); epoch timestamps start with 1.
  return digits.length >= 13 && digits.length <= 19 && /^[3-6]/.test(digits) && luhnValid(digits);
}

export const PATTERNS: readonly PatternRule[] = [
  { type: "aws_access_key", regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g },
  { type: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { type: "github_fine_grained", regex: /\bgithub_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}\b/g },
  { type: "openai_key", regex: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { type: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: "stripe_key", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { type: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  {
    type: "slack_webhook",
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{20,}/g,
  },
  { type: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { type: "google_oauth", regex: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { type: "twilio_key", regex: /\bSK[0-9a-f]{32}\b/g },
  { type: "sendgrid_key", regex: /\bSG\.[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{16,64}/g },
  { type: "npm_token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { type: "huggingface_token", regex: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { type: "gitlab_token", regex: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { type: "telegram_bot_token", regex: /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { type: "azure_storage_key", regex: /AccountKey=([A-Za-z0-9+/]{86}==)/gd, group: 1 },
  { type: "jwt", regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  { type: "bearer_token", regex: /\bbearer\s+([A-Za-z0-9._~+/-]{16,}=*)/gdi, group: 1 },
  { type: "basic_auth_url", regex: /\b[a-z][a-z0-9+.-]{0,19}:\/\/[^\s:/@]+:([^\s@/]+)@/gdi, group: 1 },
  {
    type: "private_key",
    // To the footer, or to the end of the text when the block is cut off.
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { type: "ac_api_key", regex: /\bac_(?:live|test)_[A-Za-z0-9]{8,}/g },
  {
    type: "email",
    // The last label must be letters, which keeps package versions like some-lib@2.1.0 out.
    regex: /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g,
    validate: (matched) => !isAllowedEmailDomain(matched.slice(matched.lastIndexOf("@") + 1)),
  },
  {
    type: "phone",
    regex: /(?:\+[1-9](?:[ .-]?[0-9]){7,14}|(?<![0-9])\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}(?![0-9]))/g,
  },
  { type: "card", regex: /(?<![0-9])(?:[0-9][ -]?){12,18}[0-9](?![0-9])/g, validate: cardValid },
  { type: "ssn", regex: /(?<![0-9-])(?!000|666)[0-9]{3}-(?!00)[0-9]{2}-(?!0000)[0-9]{4}(?![0-9-])/g },
];
