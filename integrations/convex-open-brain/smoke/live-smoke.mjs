import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = (process.env.OB1_CONVEX_URL || process.env.CONVEX_SITE_URL || process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const accessKey = process.env.OB1_CONVEX_KEY || process.env.MCP_ACCESS_KEY || "";
assert(baseUrl, "Set OB1_CONVEX_URL, CONVEX_SITE_URL, or NEXT_PUBLIC_API_URL.");
assert(accessKey, "Set OB1_CONVEX_KEY or MCP_ACCESS_KEY.");
const endpoint = new URL(baseUrl);
assert(!endpoint.search && !endpoint.username && !endpoint.password, "Pass a base URL without credentials.");
const cloudUrl = process.env.CONVEX_URL || (endpoint.hostname.endsWith(".convex.site") ? baseUrl.replace(/\.convex\.site$/, ".convex.cloud") : "");
assert(cloudUrl, "Set CONVEX_URL to the .convex.cloud URL when using a custom HTTP domain.");

async function request(path, init = {}, key = accessKey) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", ...(key ? { "x-brain-key": key } : {}), ...init.headers },
  });
}

function jsonContent(result) {
  assert(!result.isError, "MCP tool returned an execution error.");
  const text = result.content?.find((part) => part.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP tool must return text content.");
  return JSON.parse(text);
}

const client = new Client({ name: "ob1-deployment-smoke", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
  requestInit: { headers: { "x-brain-key": accessKey } },
});
const createdIds = [];
const checks = [];
let runError;
try {
  assert.equal((await request("/health", {}, "")).status, 401, "Missing credentials must fail.");
  assert.equal((await request("/health", {}, "invalid-smoke-key")).status, 401, "Invalid credentials must fail.");
  assert.equal((await request("/health")).status, 200, "Authenticated health failed.");
  assert.equal((await request("/mcp", { headers: { origin: "https://untrusted-smoke.invalid" } })).status, 403, "Untrusted origin must fail.");
  checks.push("HTTP auth and origin rejection");

  {
    const response = await fetch(`${cloudUrl}/api/query`, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "brain:stats", args: {}, format: "json" }),
    });
    const body = await response.json();
    assert.equal(body.status, "error", "Direct unauthenticated Convex query must not succeed.");
    checks.push("direct Convex access blocked");
  }

  await client.connect(transport);
  await client.ping();
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["search", "fetch", "search_thoughts", "list_thoughts", "thought_stats", "capture_thought"].sort());
  checks.push("SDK initialize, initialized, ping, tools/list");

  const marker = `OB1 MCP deployment smoke ${randomUUID()}`;
  const captured = jsonContent(await client.callTool({ name: "capture_thought", arguments: { content: `${marker}: verify persistent capture and semantic retrieval.` } }));
  assert.equal(typeof captured.thought_id, "string", "Capture must return its thought ID.");
  createdIds.push(captured.thought_id);
  const thought = jsonContent(await client.callTool({ name: "fetch", arguments: { id: captured.thought_id } }));
  assert.equal(thought.id, captured.thought_id);
  assert(thought.text.includes(marker));
  // Vector indexes may become visible shortly after the mutation completes.
  let found = false;
  for (let attempt = 0; attempt < 5 && !found; attempt++) {
    const search = jsonContent(await client.callTool({ name: "search", arguments: { query: marker } }));
    found = search.results.some((row) => row.id === captured.thought_id);
    if (!found && attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert(found, "Captured thought missing from semantic search.");
  for (const [name, args] of [
    ["search_thoughts", { query: marker }],
    ["list_thoughts", { limit: 5 }],
    ["thought_stats", {}],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, `${name} failed.`);
    assert(result.content?.length, `${name} returned no content.`);
  }
  checks.push("all six MCP tools, real embedding capture/search/fetch");
} catch (error) {
  runError = error;
} finally {
  const cleanup = await Promise.allSettled(createdIds.map(async (id) => {
    const deleted = await request(`/thought/${encodeURIComponent(id)}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, `Failed to clean up smoke record ${id}.`);
  }));
  const failures = cleanup.filter((result) => result.status === "rejected").map((result) => result.reason);
  try { await client.close(); } catch (error) { failures.push(error); }
  if (failures.length) {
    throw new AggregateError([...(runError ? [runError] : []), ...failures], "Smoke or cleanup failed; inspect errors before retrying.");
  }
}
if (runError) throw runError;
console.log(JSON.stringify({ ok: true, endpoint: `${baseUrl}/mcp`, checks, cleaned_up: createdIds.length }, null, 2));
