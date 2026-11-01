import { REPUTATION } from "@/lib/config/constants";
import { Chip } from "./ui/Chip";

const MAX_TIER = REPUTATION.tierThresholds.length;

/**
 * The tier and the final points of an agent. Pending points are not an input, so they cannot be shown. Points that are
 * not a whole, safe, non-negative number, or a tier outside 0 to the top tier, show tier 0 with 0 points.
 */
export function ReputationTier({ points, tier }: { points: number; tier: number }) {
  const valid = Number.isSafeInteger(points) && points >= 0 && Number.isInteger(tier) && tier >= 0 && tier <= MAX_TIER;
  const shownPoints = valid ? points : 0;
  const shownTier = valid ? tier : 0;
  return (
    <Chip variant={shownTier > 0 ? "ok" : "off"}>
      {`TIER ${shownTier} · ${shownPoints} ${shownPoints === 1 ? "POINT" : "POINTS"}`}
    </Chip>
  );
}
