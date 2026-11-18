import { describe, expect, it, vi } from "vitest";
import { OPS } from "@/lib/config/constants";
import { bucketKey, createCounters, createMemoryCounters, createMemoryStore, type CounterStore } from "@/lib/metrics/counters";

// N10 Task 3 (AC-1005, AC-1006): hourly counters of authenticated requests and of 429s.

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 18, 10, 30, 0); // 10:30 UTC

function clocked() {
  let clock = START;
  const counters = createMemoryCounters(() => clock);
  return { counters, advance: (ms: number) => (clock += ms) };
}

describe("bucketKey", () => {
  it("is one key per UTC hour and per kind", () => {
    expect(bucketKey("requests", START)).toBe("agent-court:m:requests:2026111810");
    expect(bucketKey("requests", START + 29 * 60_000)).toBe("agent-court:m:requests:2026111810");
    expect(bucketKey("requests", START + 30 * 60_000)).toBe("agent-court:m:requests:2026111811");
    expect(bucketKey("rate_limited", START)).toBe("agent-court:m:rate_limited:2026111810");
  });

  it("pads the month, day and hour", () => {
    expect(bucketKey("requests", Date.UTC(2026, 0, 2, 3))).toBe("agent-court:m:requests:2026010203");
  });
});

describe("counting and reading", () => {
  it("adds to the current hour", async () => {
    const { counters } = clocked();
    await counters.count("requests");
    await counters.count("requests");
    await counters.count("rate_limited");
    expect((await counters.read("requests", 1))).toEqual([2]);
    expect((await counters.read("rate_limited", 1))).toEqual([1]);
  });

  it("reads the last hours oldest first, with zeros for quiet hours", async () => {
    const { counters, advance } = clocked();
    await counters.count("requests"); // 10:30
    advance(HOUR);
    await counters.count("requests");
    await counters.count("requests"); // 11:30
    advance(2 * HOUR); // 13:30, nothing counted
    expect(await counters.read("requests", 4)).toEqual([1, 2, 0, 0]);
  });

  it("keeps the two kinds apart", async () => {
    const { counters } = clocked();
    await counters.count("rate_limited");
    expect(await counters.read("requests", 1)).toEqual([0]);
  });

  it("refuses an hours value that is not a whole number from 1 to the time to live", async () => {
    const { counters } = clocked();
    for (const hours of [0, -1, 1.5, Number.NaN, OPS.counterTtlDays * 24 + 1]) {
      await expect(counters.read("requests", hours)).rejects.toThrow();
    }
    await expect(counters.read("requests", OPS.counterTtlDays * 24)).resolves.toHaveLength(OPS.counterTtlDays * 24);
  });
});

describe("expiry", () => {
  it("drops a key once its time to live has passed", async () => {
    let clock = START;
    const store = createMemoryStore(() => clock);
    await store.incr("k", 10);
    clock += 9_999;
    expect(await store.mget(["k"])).toEqual([1]);
    clock += 1;
    expect(await store.mget(["k"])).toEqual([0]);
  });

  it("asks for a time to live of eight days on every count", async () => {
    const incr = vi.fn(async () => undefined);
    const store: CounterStore = { incr, mget: async (keys) => keys.map(() => 0) };
    await createCounters(store, () => START).count("requests");
    expect(incr).toHaveBeenCalledWith("agent-court:m:requests:2026111810", OPS.counterTtlDays * 86_400);
  });
});

describe("a store that fails", () => {
  const failing: CounterStore = {
    incr: async () => {
      throw new Error("redis down: password hunter2hunter2");
    },
    mget: async () => {
      throw new Error("redis down");
    },
  };

  it("never makes count() reject, so a request never fails because a counter did", async () => {
    await expect(createCounters(failing).count("requests")).resolves.toBeUndefined();
  });

  it("logs the class of the error and nothing from its message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await createCounters(failing).count("rate_limited");
    const text = warn.mock.calls.flat().join("\n");
    warn.mockRestore();
    expect(text).toContain("counter not recorded");
    expect(text).not.toContain("hunter2");
  });

  it("lets read() reject, so the page can say the number is unknown instead of showing a zero", async () => {
    await expect(createCounters(failing).read("requests", 1)).rejects.toThrow();
  });
});
