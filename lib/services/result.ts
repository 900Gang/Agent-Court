/** A service outcome: a value, or a short machine-readable error with optional field messages. */
export type ServiceResult<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E; detail?: Record<string, string> };

export function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

export function fail<E extends string>(
  error: E,
  detail?: Record<string, string>,
): { ok: false; error: E; detail?: Record<string, string> } {
  return detail ? { ok: false, error, detail } : { ok: false, error };
}
