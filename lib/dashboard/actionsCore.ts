import type { Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import type { EmbeddingProvider } from "@/lib/embeddings/provider";
import { assertSameOrigin } from "@/lib/http/origin";
import { createAgent, setAgentStatus } from "@/lib/services/agentService";
import { issueKey, revokeKey } from "@/lib/services/keyService";
import { agentFormToInput, issueKeyFormToInput } from "./forms";
import { describeError, type ActionError } from "./messages";

export interface ActionDeps {
  db: Database;
  operator: Operator | null;
  headers: Headers;
  expectedOrigin: string;
  /** The embeddings provider, for the admin actions that publish a case. Null or absent: nothing is embedded. */
  embedder?: EmbeddingProvider | null;
  now?: Date;
}

export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ActionError; fieldErrors?: Record<string, string> };

/** The shape a form action has: it receives the previous state and the form data. */
export type FormAction<T> = (previous: unknown, formData: FormData) => Promise<ActionResult<T> | { ok: false }>;

export interface IssuedKey {
  keyId: string;
  /** The raw key. It is returned here once and stored nowhere. */
  key: string;
  fingerprint: string;
  scopes: string[];
  expiresAt: string | null;
  label: string | null;
}

export function failure(error: string, fieldErrors?: Record<string, string>): ActionResult<never> {
  return fieldErrors ? { ok: false, error: describeError(error), fieldErrors } : { ok: false, error: describeError(error) };
}

/** Every write starts here: the origin is checked first, then that someone is signed in. */
export function guard(deps: ActionDeps): { operator: Operator } | { failure: ActionResult<never> } {
  try {
    assertSameOrigin(deps.headers, deps.expectedOrigin);
  } catch {
    return { failure: failure("origin_mismatch") };
  }
  if (!deps.operator) return { failure: failure("not_signed_in") };
  return { operator: deps.operator };
}

export async function registerAgentCore(
  deps: ActionDeps,
  formData: FormData,
): Promise<ActionResult<{ agentId: string; handle: string }>> {
  const guarded = guard(deps);
  if ("failure" in guarded) return guarded.failure;
  const result = await createAgent(deps.db, guarded.operator, agentFormToInput(formData));
  if (!result.ok) return failure(result.error, result.detail);
  return { ok: true, value: { agentId: result.value.id, handle: result.value.handle } };
}

export async function setAgentStatusCore(
  deps: ActionDeps,
  agentId: string,
  status: "active" | "suspended",
): Promise<ActionResult<{ status: "active" | "suspended" }>> {
  const guarded = guard(deps);
  if ("failure" in guarded) return guarded.failure;
  const result = await setAgentStatus(deps.db, guarded.operator, agentId, status);
  if (!result.ok) return failure(result.error, result.detail);
  return { ok: true, value: { status: result.value.status } };
}

export async function issueKeyCore(
  deps: ActionDeps,
  agentId: string,
  formData: FormData,
): Promise<ActionResult<IssuedKey>> {
  const guarded = guard(deps);
  if ("failure" in guarded) return guarded.failure;
  const result = await issueKey(deps.db, guarded.operator, agentId, issueKeyFormToInput(formData), deps.now);
  if (!result.ok) return failure(result.error, result.detail);
  const { key, record } = result.value;
  return {
    ok: true,
    value: {
      keyId: record.id,
      key,
      fingerprint: `${record.keyPrefix}…`,
      scopes: record.scopes,
      expiresAt: record.expiresAt === null ? null : record.expiresAt.toISOString(),
      label: record.label,
    },
  };
}

export async function revokeKeyCore(
  deps: ActionDeps,
  keyId: string,
): Promise<ActionResult<{ keyId: string; revokedAt: string }>> {
  const guarded = guard(deps);
  if ("failure" in guarded) return guarded.failure;
  const result = await revokeKey(deps.db, guarded.operator, keyId, deps.now);
  if (!result.ok) return failure(result.error, result.detail);
  const revokedAt = result.value.revokedAt ?? deps.now ?? new Date();
  return { ok: true, value: { keyId: result.value.id, revokedAt: revokedAt.toISOString() } };
}
