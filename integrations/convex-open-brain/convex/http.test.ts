/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import * as brain from "./brain";
import * as agentMemory from "./agentMemory";
import { getEmbedding } from "./lib/openrouter";

vi.mock("./lib/openrouter", () => ({
  getEmbedding: vi.fn(async () => [1, ...Array<number>(1535).fill(0)]),
  extractMetadata: vi.fn(async () => ({ type: "observation", topics: ["test"] })),
}));

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const agentKey = "test-agent-key";
const adminKey = "test-admin-key";
const makeTest = () => convexTest(schema, modules);
type TestBackend = ReturnType<typeof makeTest>;

function rpc(t: TestBackend, body: unknown, headers: Record<string, string> = {}) {
  return t.fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-key": agentKey, ...headers },
    body: JSON.stringify(body),
  });
}

function call(t: TestBackend, name: string, args: Record<string, unknown> = {}) {
  return rpc(t, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

beforeEach(() => {
  vi.stubEnv("MCP_ACCESS_KEY", agentKey);
  vi.stubEnv("MCP_ADMIN_KEY", adminKey);
  vi.stubEnv("MCP_ALLOWED_ORIGINS", "https://approved.example");
});
afterEach(() => vi.unstubAllEnvs());

describe("MCP security and lifecycle", () => {
  it("keeps every database function internal to prevent direct Convex auth bypass", () => {
    for (const fn of [...Object.values(brain), ...Object.values(agentMemory)]) {
      expect(fn).toHaveProperty("isInternal", true);
      expect(fn).not.toHaveProperty("isPublic", true);
    }
  });

  it("rejects absent and invalid credentials, including when access key is unset", async () => {
    const t = makeTest();
    expect((await t.fetch("/health")).status).toBe(401);
    expect((await rpc(t, { jsonrpc: "2.0", id: 1, method: "ping" }, { "x-brain-key": "wrong" })).status).toBe(401);
    vi.stubEnv("MCP_ACCESS_KEY", "");
    expect((await rpc(t, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(401);
  });

  it("accepts header, bearer, and legacy URL credentials", async () => {
    const t = makeTest();
    for (const [path, headers] of [
      ["/health", { "x-brain-key": agentKey }],
      ["/health", { authorization: `Bearer ${agentKey}` }],
      [`/health?key=${agentKey}`, {}],
    ] satisfies Array<[string, Record<string, string>]>) {
      expect((await t.fetch(path, { headers })).status).toBe(200);
    }
  });

  it("blocks untrusted browser origins, permits configured origins and native clients", async () => {
    const t = makeTest();
    const ping = { jsonrpc: "2.0", id: 2, method: "ping" };
    expect((await rpc(t, ping, { origin: "https://untrusted.example" })).status).toBe(403);
    expect((await rpc(t, ping, { origin: "null" })).status).toBe(403);
    expect((await rpc(t, ping, { origin: "https://approved.example" })).status).toBe(200);
    expect((await rpc(t, ping)).status).toBe(200);
  });

  it("completes initialize, initialized, ping and tool discovery", async () => {
    const t = makeTest();
    const initialize = await rpc(t, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(await initialize.json()).toMatchObject({ id: 1, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    const initialized = await rpc(t, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(initialized.status).toBe(202);
    expect(await initialized.text()).toBe("");
    expect(await (await rpc(t, { jsonrpc: "2.0", id: 2, method: "ping" })).json()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    const listing = await (await rpc(t, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
    expect(listing.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "search", "fetch", "search_thoughts", "list_thoughts", "thought_stats", "capture_thought",
    ]);
    expect((await t.fetch("/mcp", { headers: { "x-brain-key": agentKey, accept: "text/event-stream" } })).status).toBe(405);
  });

  it("returns protocol errors for malformed JSON and invalid requests", async () => {
    const t = makeTest();
    const malformed = await t.fetch("/mcp", { method: "POST", headers: { "x-brain-key": agentKey, "content-type": "application/json" }, body: "{" });
    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
    for (const body of [null, {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }]) {
      expect(await (await rpc(t, body)).json()).toMatchObject({ error: { code: -32600 } });
    }
    expect(await (await rpc(t, { jsonrpc: "2.0", id: 1, method: "not-supported" })).json()).toMatchObject({ error: { code: -32601 } });
  });

  it("validates initialization fields and protocol headers", async () => {
    const t = makeTest();
    expect(await (await rpc(t, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json()).toMatchObject({ error: { code: -32602 } });
    const ping = { jsonrpc: "2.0", id: 2, method: "ping" };
    expect((await rpc(t, ping, { "mcp-protocol-version": "unsupported" })).status).toBe(400);
    expect((await rpc(t, ping, { "mcp-protocol-version": "2025-11-25" })).status).toBe(200);
    expect((await t.fetch("/mcp", { method: "OPTIONS", headers: { origin: "https://untrusted.example" } })).status).toBe(403);
    expect((await t.fetch("/mcp", { method: "OPTIONS", headers: { origin: "https://approved.example" } })).status).toBe(204);
  });

  it("acknowledges notification batches without JSON-RPC replies", async () => {
    const t = makeTest();
    const notifications = await rpc(t, [{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    expect(notifications.status).toBe(202);
    expect(await notifications.text()).toBe("");
    const mixed = await rpc(t, [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "ping", method: "ping" },
    ]);
    expect(await mixed.json()).toEqual([{ jsonrpc: "2.0", id: "ping", result: {} }]);
  });
});

describe("MCP tools through Convex HTTP", () => {
  it("captures, searches, fetches and lists real records while excluding restricted thoughts", async () => {
    const t = makeTest();
    const capture = await (await call(t, "capture_thought", { content: "MCP test: remember the deployment checklist." })).json();
    expect(capture.error).toBeUndefined();
    expect(capture.result.isError).not.toBe(true);
    const rows = await t.run((ctx) => ctx.db.query("thoughts").collect());
    expect(rows).toHaveLength(1);
    const id = rows[0]._id;
    const hidden = await t.action(internal.brain.captureThought, { content: "Restricted deployment checklist", sensitivity_tier: "restricted" });

    const fetchResult = await (await call(t, "fetch", { id })).json();
    expect(JSON.parse(fetchResult.result.content[0].text)).toMatchObject({ id, text: rows[0].content });
    const search = await (await call(t, "search", { query: "deployment checklist" })).json();
    expect(JSON.parse(search.result.content[0].text).results.map((row: { id: string }) => row.id)).toEqual([id]);
    const searchThoughts = await (await call(t, "search_thoughts", { query: "deployment checklist" })).json();
    expect(searchThoughts.result.content[0].text).toContain(rows[0].content);
    expect(searchThoughts.result.content[0].text).not.toContain("Restricted deployment");
    const listing = await (await call(t, "list_thoughts")).json();
    expect(listing.result.content[0].text).toContain(rows[0].content);
    expect(listing.result.content[0].text).not.toContain("Restricted deployment");
    const stats = await (await call(t, "thought_stats")).json();
    expect(JSON.parse(stats.result.content[0].text).total_thoughts).toBe(1);
    const restrictedFetch = await (await call(t, "fetch", { id: hidden.thought_id })).json();
    expect(Boolean(restrictedFetch.error || restrictedFetch.result?.isError)).toBe(true);
  });

  it("rejects invalid tool inputs before writing or searching", async () => {
    const t = makeTest();
    for (const [name, args] of [
      ["capture_thought", { content: " " }],
      ["search", { query: 3 }],
      ["list_thoughts", { limit: -1 }],
      ["search_thoughts", { query: "test", limit: 1.2 }],
      ["unknown", {}],
    ] satisfies Array<[string, Record<string, unknown>]>) {
      const result = await (await call(t, name, args)).json();
      expect(Boolean(result.error || result.result?.isError)).toBe(true);
    }
    expect(await t.run((ctx) => ctx.db.query("thoughts").collect())).toEqual([]);
  });

  it("reports provider failures as tool errors without capturing a partial record", async () => {
    const t = makeTest();
    vi.mocked(getEmbedding).mockRejectedValueOnce(new Error("Embedding provider unavailable"));
    const result = await (await call(t, "capture_thought", { content: "A valid thought" })).json();
    expect(result).toMatchObject({ result: { isError: true, content: [{ type: "text", text: "Embedding provider unavailable" }] } });
    expect(await t.run((ctx) => ctx.db.query("thoughts").collect())).toEqual([]);
  });
});
