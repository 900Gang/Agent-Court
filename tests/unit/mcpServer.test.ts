import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiDeps } from "@/lib/http/apiPipeline";
import { SERVER_INSTRUCTIONS, createCourtServer } from "@/lib/mcp/server";
import { TOOL_NAMES } from "@/lib/mcp/schemas";

// Initialize and tools/list never call a REST handler, so no database is needed here.
const noDeps = {} as ApiDeps;
const context = (authorization = "Bearer ac_live_unit_test_not_a_real_key") => ({ authorization, deps: noDeps });

async function connect(authorization?: string) {
  const server = createCourtServer(context(authorization));
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { server, client };
}

describe("createCourtServer: what the client learns at initialize", () => {
  it("is named agent-court and carries the package version", async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe("agent-court");
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(client.getServerVersion()?.version).toBe(pkg.version);
    await client.close();
  });

  it("sends the instructions text exactly", async () => {
    const { client } = await connect();
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    await client.close();
  });

  it("offers tools and nothing else", async () => {
    const { client } = await connect();
    const capabilities = client.getServerCapabilities() ?? {};
    expect(capabilities).toHaveProperty("tools");
    for (const unsupported of ["resources", "prompts", "logging", "completions", "sampling", "elicitation"]) {
      expect(capabilities, unsupported).not.toHaveProperty(unsupported);
    }
    await client.close();
  });

  it("lists the five tools", async () => {
    const { client } = await connect();
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(Object.values(TOOL_NAMES).sort());
    await client.close();
  });
});

describe("SERVER_INSTRUCTIONS", () => {
  it("tells the agent how to start, what untrusted text is, what held means and how to retry", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/court_search_precedents/);
    expect(SERVER_INSTRUCTIONS).toMatch(/court_list_open_cases/);
    expect(SERVER_INSTRUCTIONS).toMatch(/untrusted_content/);
    expect(SERVER_INSTRUCTIONS).toMatch(/data/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/instructions/i);
    expect(SERVER_INSTRUCTIONS).toMatch(/held_for_review/);
    expect(SERVER_INSTRUCTIONS).toMatch(/idempotency_key/);
  });

  it("is a plain constant: no placeholder, no interpolation, a sensible size", () => {
    expect(typeof SERVER_INSTRUCTIONS).toBe("string");
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\$\{|\{\{|undefined|null|\[object/);
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThan(200);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(3000);
  });

  it("names only tools that exist", () => {
    const named = new Set(SERVER_INSTRUCTIONS.match(/court_[a-z_]+/g) ?? []);
    const real = new Set<string>(Object.values(TOOL_NAMES));
    for (const name of named) expect(real.has(name), name).toBe(true);
  });
});

describe("two servers are independent", () => {
  it("are different objects, each with its own five tools", async () => {
    const first = await connect();
    const second = await connect();
    expect(first.server).not.toBe(second.server);
    expect((await first.client.listTools()).tools).toHaveLength(5);
    expect((await second.client.listTools()).tools).toHaveLength(5);
    await first.client.close();
    // Closing one does not break the other.
    expect((await second.client.listTools()).tools).toHaveLength(5);
    await second.client.close();
  });

  it("give the same instructions and tools whatever key they were made for, and never contain the key", async () => {
    const one = await connect("Bearer ac_live_first_key_value_0001");
    const two = await connect("Bearer ac_live_second_key_value_0002");
    const describeServer = async (client: Client) =>
      JSON.stringify({ instructions: client.getInstructions(), info: client.getServerVersion(), tools: (await client.listTools()).tools });
    const a = await describeServer(one.client);
    const b = await describeServer(two.client);
    expect(a).toBe(b);
    expect(a).not.toContain("ac_live_first_key_value_0001");
    expect(a).not.toContain("ac_live_second_key_value_0002");
    await one.client.close();
    await two.client.close();
  });
});
