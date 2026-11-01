import { EmailError, type EmailMessage, type EmailProvider } from "@/lib/email/provider";

// Test-only mailers. Nothing under app/, lib/ or components/ may import this file.

export interface RecordingMailer extends EmailProvider {
  /** Every message that was accepted, in order. */
  messages: EmailMessage[];
  /** Every attempt, accepted or not: how many times the provider was asked. */
  attempts: number;
  /** Makes the next `count` sends fail with a provider error (the message is not recorded). */
  failNext(count?: number): void;
}

/** Records exactly what it was asked to send, and can be told to fail. */
export function createRecordingMailer(): RecordingMailer {
  let failures = 0;
  const mailer: RecordingMailer = {
    messages: [],
    attempts: 0,
    failNext(count = 1) {
      failures = count;
    },
    async send(message) {
      mailer.attempts += 1;
      if (failures > 0) {
        failures -= 1;
        throw new EmailError("unavailable", 503);
      }
      mailer.messages.push({ ...message });
    },
  };
  return mailer;
}

/** Fails every send with something that is not even a provider error. */
export const throwingMailer: EmailProvider = {
  async send() {
    throw new Error("the mail server exploded: SENTINEL_FAILURE_TEXT");
  },
};
