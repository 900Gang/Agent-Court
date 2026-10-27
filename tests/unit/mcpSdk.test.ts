import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

// These tests prove the SDK fits how N5 will use it. They do not test our code.

describe("the MCP SDK dependency", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("is a runtime dependency pinned to one exact version", () => {
    const version = pkg.dependencies?.["@modelcontextprotocol/sdk"];
    expect(version, "missing from dependencies").toBeDefined();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
  });

  it("exports the modules N5 uses", () => {
    for (const exported of [McpServer, Client, StreamableHTTPClientTransport, InMemoryTransport, WebStandardStreamableHTTPServerTransport]) {
      expect(typeof exported).toBe("function");
    }
  });
});

function spikeServer(): McpServer {
  const server = new McpServer({ name: "spike", version: "0.0.1" }, { instructions: "Spike instructions." });
  server.registerTool(
    "echo",
    {
      description: "Echo a short note.",
      inputSchema: {
        note: z.string().min(1).max(10).describe("A short note."),
        // A schema with a preprocess step, like several of ours: listing the tool must not throw.
        times: z
          .preprocess((value) => (value === undefined ? 1 : value), z.number().int().min(1).max(3))
          .optional()
          .describe("How many times."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ note }) => ({ content: [{ type: "text" as const, text: note }], structuredContent: { note } }),
  );
  return server;
}

describe("the SDK in memory (the pattern for tool tests)", () => {
  async function connected() {
    const server = spikeServer();
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { server, client };
  }

  it("lists a tool with its annotations and the descriptions of its fields", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    const [tool] = tools;
    expect(tool.description).toBe("Echo a short note.");
    expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    const properties = tool.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.note.description).toBe("A short note.");
    expect(properties.times).toBeDefined();
    await client.close();
  });

  it("returns structured content and the instructions", async () => {
    const { client } = await connected();
    expect(client.getServerVersion()?.name).toBe("spike");
    expect(client.getInstructions()).toBe("Spike instructions.");
    const result = await client.callTool({ name: "echo", arguments: { note: "hi" } });
    expect(result.structuredContent).toEqual({ note: "hi" });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it("does not run a tool with invalid arguments", async () => {
    const { client } = await connected();
    const outcome = await client
      .callTool({ name: "echo", arguments: { note: "" } })
      .then((result) => ({ failed: result.isError === true }), () => ({ failed: true }));
    expect(outcome.failed).toBe(true);
    await client.close();
  });
});

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0.0.1" } },
};

const post = (body: unknown) =>
  new Request("http://localhost:3000/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

async function statelessHandle(request: Request, parsedBody?: unknown): Promise<Response> {
  // A stateless server is built fresh for every request.
  const server = spikeServer();
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, parsedBody === undefined ? undefined : { parsedBody });
  } finally {
    await server.close();
  }
}

describe("the web-standard transport, stateless and JSON (the pattern for the route)", () => {
  it("answers initialize with plain JSON and no session id", async () => {
    const response = await statelessHandle(post(initializeBody));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = await response.json();
    expect(body.result.serverInfo.name).toBe("spike");
    expect(body.result.instructions).toBe("Spike instructions.");
  });

  it("accepts a body the caller already read and parsed", async () => {
    const request = post(initializeBody);
    const parsed = await request.json();
    const response = await statelessHandle(request, parsed);
    expect(response.status).toBe(200);
    expect((await response.json()).result.serverInfo.name).toBe("spike");
  });

  it("serves two requests one after the other, each with a fresh server", async () => {
    expect((await statelessHandle(post(initializeBody))).status).toBe(200);
    expect((await statelessHandle(post({ ...initializeBody, id: 2 }))).status).toBe(200);
  });

  it("requires the Accept header the specification asks for, and says so with a client error", async () => {
    const bare = new Request("http://localhost:3000/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(initializeBody),
    });
    const response = await statelessHandle(bare);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});

describe("a real SDK client over HTTP, with our own fetch standing in for the network", () => {
  it("initializes, lists and calls through a per-request server", async () => {
    const seen: Array<{ method: string; authorization: string | null }> = [];
    const route: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push({ method: request.method, authorization: request.headers.get("authorization") });
      // We never push anything to the client, so a GET (the optional event stream) is refused.
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      return statelessHandle(request, await request.clone().json());
    };

    const client = new Client({ name: "http-client", version: "0.0.1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp"), {
        fetch: route,
        requestInit: { headers: { authorization: "Bearer test-key" } },
      }),
    );

    expect(client.getServerVersion()?.name).toBe("spike");
    expect(client.getInstructions()).toBe("Spike instructions.");
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await client.callTool({ name: "echo", arguments: { note: "over http" } });
    expect(result.structuredContent).toEqual({ note: "over http" });
    expect(seen.filter((call) => call.method === "POST").every((call) => call.authorization === "Bearer test-key")).toBe(true);
    await client.close();
  });
});
