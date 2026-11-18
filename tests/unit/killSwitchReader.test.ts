import { describe, expect, it, vi } from "vitest";
import { OPS } from "@/lib/config/constants";
import { createKillSwitchReader } from "@/lib/services/killSwitchService";

// N10 Task 1 (AC-1007): the reader behind the proxy. It caches the database value for a few seconds, lets the
// environment switch win, and never lets a database error flip the switch by itself.

function setup(over: { read?: () => Promise<boolean>; envOn?: boolean; ttlMs?: number } = {}) {
  let clock = 1_000_000;
  const read = vi.fn(over.read ?? (async () => false));
  const reader = createKillSwitchReader({
    read,
    envOn: () => over.envOn ?? false,
    now: () => clock,
    ...(over.ttlMs === undefined ? {} : { ttlMs: over.ttlMs }),
  });
  return { reader, read, advance: (ms: number) => (clock += ms) };
}

describe("the cache time", () => {
  it("is five seconds", () => {
    expect(OPS.killSwitchCacheMs).toBe(5000);
  });
});

describe("createKillSwitchReader", () => {
  it("reads the database value when the environment switch is off", async () => {
    const { reader } = setup({ read: async () => true });
    expect(await reader.isOn()).toBe(true);
  });

  it("answers off when the database says off", async () => {
    const { reader } = setup({ read: async () => false });
    expect(await reader.isOn()).toBe(false);
  });

  it("lets the environment switch win without reading the database at all", async () => {
    const { reader, read } = setup({ envOn: true, read: async () => false });
    expect(await reader.isOn()).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("reads once for many calls inside the cache time", async () => {
    const { reader, read, advance } = setup();
    await reader.isOn();
    advance(OPS.killSwitchCacheMs - 1);
    await reader.isOn();
    await reader.isOn();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads again once the cache time has passed, so a flip takes effect within seconds", async () => {
    let value = false;
    const { reader, read, advance } = setup({ read: async () => value });
    expect(await reader.isOn()).toBe(false);
    value = true;
    expect(await reader.isOn()).toBe(false); // still cached
    advance(OPS.killSwitchCacheMs);
    expect(await reader.isOn()).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("honours a cache time given to it", async () => {
    const { reader, read, advance } = setup({ ttlMs: 100 });
    await reader.isOn();
    advance(100);
    await reader.isOn();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("invalidate() makes the next call read again", async () => {
    const { reader, read } = setup();
    await reader.isOn();
    reader.invalidate();
    await reader.isOn();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not turn the switch off when the database fails after it was on", async () => {
    let fail = false;
    const { reader, advance } = setup({
      read: async () => {
        if (fail) throw new Error("connection lost");
        return true;
      },
    });
    expect(await reader.isOn()).toBe(true);
    fail = true;
    advance(OPS.killSwitchCacheMs);
    expect(await reader.isOn()).toBe(true);
  });

  it("does not turn the switch on when the database fails after it was off", async () => {
    let fail = false;
    const { reader, advance } = setup({
      read: async () => {
        if (fail) throw new Error("connection lost");
        return false;
      },
    });
    expect(await reader.isOn()).toBe(false);
    fail = true;
    advance(OPS.killSwitchCacheMs);
    expect(await reader.isOn()).toBe(false);
  });

  it("uses the environment value when the very first read fails", async () => {
    const { reader } = setup({
      read: async () => {
        throw new Error("connection lost");
      },
      envOn: false,
    });
    expect(await reader.isOn()).toBe(false);
  });

  it("does not throw when the database fails, and does not hammer it: a failed read is tried again only after the cache time", async () => {
    const { reader, read, advance } = setup({
      read: async () => {
        throw new Error("connection lost");
      },
    });
    await expect(reader.isOn()).resolves.toBe(false);
    await expect(reader.isOn()).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    advance(OPS.killSwitchCacheMs);
    await reader.isOn();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("treats a read that never answers as a failure after the time limit, and keeps the last known value", async () => {
    let hang = false;
    const reader = createKillSwitchReader({
      read: () => (hang ? new Promise<boolean>(() => undefined) : Promise.resolve(true)),
      envOn: () => false,
      ttlMs: 0,
      timeoutMs: 20,
    });
    expect(await reader.isOn()).toBe(true);
    hang = true;
    expect(await reader.isOn()).toBe(true);
  });

  it("has a default time limit that is short, so a slow database cannot stall every request", () => {
    expect(OPS.killSwitchReadTimeoutMs).toBeLessThanOrEqual(2000);
  });

  it("shares one read between calls that arrive at the same time", async () => {
    let release: (value: boolean) => void = () => undefined;
    const { reader, read } = setup({ read: () => new Promise<boolean>((resolve) => (release = resolve)) });
    const calls = [reader.isOn(), reader.isOn(), reader.isOn()];
    release(true);
    expect(await Promise.all(calls)).toEqual([true, true, true]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
