export type EmailErrorCode = "timeout" | "rejected" | "unavailable";

// Fixed text per code. Nothing from the request, the response or the connection error is ever put into an error: the
// message holds an address, the response may echo it, and the key travels in a header.
const MESSAGES: Record<EmailErrorCode, string> = {
  timeout: "the mail service did not answer in time",
  rejected: "the mail service refused the message",
  unavailable: "the mail service could not be used right now",
};

export class EmailError extends Error {
  readonly code: EmailErrorCode;
  /** The HTTP status, when the service answered. */
  readonly status: number | undefined;

  constructor(code: EmailErrorCode, status?: number) {
    super(MESSAGES[code]);
    this.name = "EmailError";
    this.code = code;
    this.status = status;
  }
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  /** Sends one message. Fails with an EmailError. */
  send(message: EmailMessage, options?: { timeoutMs?: number }): Promise<void>;
}

const ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * The Resend API, called with a plain fetch. The key never leaves the Authorization header. A refusal's body is never
 * read, because it can echo the message. A 429 or a 5xx is worth trying again later (`unavailable`); any other refusal
 * will not change by waiting (`rejected`).
 */
export function createResendProvider(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    async send(message, options = {}) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetchImpl(ENDPOINT, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw new EmailError(retryable ? "unavailable" : "rejected", response.status);
        }
      } catch (error) {
        if (error instanceof EmailError) throw error;
        throw new EmailError(timedOut ? "timeout" : "unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
