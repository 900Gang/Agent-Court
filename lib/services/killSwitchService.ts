import { eq } from "drizzle-orm";
import { operators, systemFlags } from "@/db/schema";
import type { Operator } from "@/db/schema";
import type { Database } from "@/db/types";
import { isActiveAdmin } from "@/lib/auth/isActiveAdmin";
import { OPS } from "@/lib/config/constants";
import { parseAdminReason } from "./adminReason";
import { writeAudit } from "./auditService";
import { fail, ok, type ServiceResult } from "./result";

export const KILL_SWITCH_KEY = "kill_switch";

/** Whether the global switch is on in the database. Off when nothing has ever been set. */
export async function getKillSwitch(db: Database): Promise<boolean> {
  const [row] = await db.select({ value: systemFlags.value }).from(systemFlags).where(eq(systemFlags.key, KILL_SWITCH_KEY)).limit(1);
  return row?.value ?? false;
}

type SetResult = ServiceResult<{ on: boolean }, "forbidden" | "invalid_reason">;

/**
 * An administrator turns the global switch on or off. The admin is read from the database again (an object that was
 * handed in may be stale), the reason must be 10 to 200 characters, and the row is locked while it is compared and
 * changed. A change writes one audit row with the admin's id, the new value and the reason; asking for the value that is
 * already set changes and writes nothing.
 */
export async function setKillSwitch(db: Database, admin: Operator, value: boolean, reason: string): Promise<SetResult> {
  return db.transaction(async (tx): Promise<SetResult> => {
    const [current] = await tx.select().from(operators).where(eq(operators.id, admin.id)).limit(1);
    if (!current || !isActiveAdmin(current)) return fail("forbidden");
    const cleaned = parseAdminReason(reason);
    if (cleaned === null) return fail("invalid_reason");

    const [row] = await tx.select().from(systemFlags).where(eq(systemFlags.key, KILL_SWITCH_KEY)).limit(1).for("update");
    if ((row?.value ?? false) === value) return ok({ on: value });

    await tx
      .insert(systemFlags)
      .values({ key: KILL_SWITCH_KEY, value, updatedBy: current.id })
      .onConflictDoUpdate({ target: systemFlags.key, set: { value, updatedBy: current.id, updatedAt: new Date() } });
    await writeAudit(tx, {
      actorType: "operator",
      actorId: current.id,
      action: "killswitch.set",
      target: KILL_SWITCH_KEY,
      metadata: { value, reason: cleaned },
    });
    return ok({ on: value });
  });
}

/** The read, or a rejection when it takes longer than the limit. The late answer, if one comes, is ignored. */
function readWithTimeout(read: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface KillSwitchReader {
  /** True when the switch is on. Never throws. */
  isOn(): Promise<boolean>;
  /** Forget the cached value, so the next call reads again. */
  invalidate(): void;
}

/**
 * The reader behind the proxy. The environment switch wins and needs no read. Otherwise the database value is cached for
 * a few seconds. A failed read keeps the last value that was known (or off, when none was), and is tried again only
 * after the cache time: a database error never flips the switch by itself and never turns every request into a retry.
 * A read that takes longer than `timeoutMs` counts as failed. Calls that arrive while a read is under way share it.
 */
export function createKillSwitchReader(options: {
  read: () => Promise<boolean>;
  envOn: () => boolean;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}): KillSwitchReader {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? OPS.killSwitchCacheMs;
  const timeoutMs = options.timeoutMs ?? OPS.killSwitchReadTimeoutMs;
  let known: boolean | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<boolean> | null = null;

  return {
    isOn() {
      if (options.envOn()) return Promise.resolve(true);
      if (now() - fetchedAt < ttlMs) return Promise.resolve(known ?? false);
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          known = await readWithTimeout(options.read, timeoutMs);
        } catch {
          // Keep what was known. The error is not logged here: the proxy runs for every request.
        } finally {
          fetchedAt = now();
          inflight = null;
        }
        return known ?? false;
      })();
      return inflight;
    },
    invalidate() {
      fetchedAt = Number.NEGATIVE_INFINITY;
    },
  };
}
