import { getDb } from "@/db/client";
import { getServerEnv } from "@/lib/config/env";
import { createKillSwitchReader, getKillSwitch, type KillSwitchReader } from "@/lib/services/killSwitchService";

// One reader per process. It caches the database value for a few seconds, so the proxy does not read the database for every request.
let reader: KillSwitchReader | null = null;

function getReader(): KillSwitchReader {
  reader ??= createKillSwitchReader({ read: () => getKillSwitch(getDb()), envOn: () => getServerEnv().killSwitch });
  return reader;
}

/** True when agent traffic must be stopped: the environment switch is on, or the database flag is. Never throws. */
export function isKillSwitchOn(): Promise<boolean> {
  return getReader().isOn();
}

/** Makes this process read the flag again at the next request. Other processes catch up within the cache time. */
export function invalidateKillSwitch(): void {
  reader?.invalidate();
}
