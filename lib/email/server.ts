import "server-only";
import { getServerEnv } from "@/lib/config/env";
import { createResendProvider, type EmailProvider } from "./provider";

let cached: { key: string; from: string; provider: EmailProvider } | undefined;

/** The real provider, or null unless both the key and the sender are set: then nothing is ever sent. */
export function getEmailProvider(): EmailProvider | null {
  const { resendApiKey, emailFrom } = getServerEnv();
  if (!resendApiKey || !emailFrom) return null;
  if (cached?.key !== resendApiKey || cached.from !== emailFrom) cached = { key: resendApiKey, from: emailFrom, provider: createResendProvider(resendApiKey, emailFrom) };
  return cached.provider;
}
