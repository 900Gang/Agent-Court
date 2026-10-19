/** Removes control characters; newlines and tabs are kept. */
export function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}
