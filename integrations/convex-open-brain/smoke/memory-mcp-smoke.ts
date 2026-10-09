import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const baseUrl = (process.env.OB1_CONVEX_URL || process.env.CONVEX_SITE_URL || process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const agentKey = process.env.OB1_CONVEX_KEY || process.env.MCP_ACCESS_KEY || "";
const adminKey = process.env.OB1_CONVEX_ADMIN_KEY || process.env.MCP_ADMIN_KEY || "";
assert(baseUrl, "Set OB1_CONVEX_URL, CONVEX_SITE_URL, or NEXT_PUBLIC_API_URL.");
assert(agentKey, "Set OB1_CONVEX_KEY or MCP_ACCESS_KEY.");
assert(adminKey, "Set OB1_CONVEX_ADMIN_KEY or MCP_ADMIN_KEY for smoke cleanup.");
assert.notEqual(agentKey, adminKey, "Agent and admin keys must differ.");
const endpoint = new URL(baseUrl);
assert(!endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password && endpoint.pathname === "/", "Pass a base URL without credentials, query, fragment, or path.");
assert(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)), "Use HTTPS, except for local development.");

// Both scopes are unique: smoke never reviews an existing project's memory.
const runId = randomUUID();
const workspaceId = `ob1-mcp-smoke-${runId}`;
const projectId = `mcp-smoke-${runId}`;
const marker = `OB1 Agent Memory verification ${runId}`;
const sample = `${marker}: generated verification evidence must remain pending human review.`;
const createdIds = new Set<string>();
const checks: string[] = [];
let client: Client | undefined;
let stage = "setup";

function record(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function memories(value: Record<string, unknown>): Record<string, unknown>[] {
  assert(Array.isArray(value.memories), "Response must include memories.");
  return value.memories.map((memory) => record(memory, "memory"));
}

function ownedMemoryId(memory: Record<string, unknown>): string {
  assert(typeof memory.memory_id === "string" && memory.memory_id, "Memory must have an ID.");
  assert.equal(memory.content, sample, "Smoke memory content changed.");
  const scope = record(memory.scope, "scope");
  assert.equal(scope.workspace_id, workspaceId, "Memory escaped smoke workspace.");
  assert.equal(scope.project_id, projectId, "Memory escaped smoke project.");
  return memory.memory_id;
}

function assertEvidence(memory: Record<string, unknown>): void {
  ownedMemoryId(memory);
  assert.equal(record(memory.provenance, "provenance").status, "generated");
  assert.deepEqual(record(memory.use_policy, "use_policy"), {
    can_use_as_instruction: false,
    can_use_as_evidence: true,
    requires_user_confirmation: true,
  });
}

async function connect(): Promise<Client> {
  const next = new Client({ name: "ob1-agent-memory-smoke", version: "1.0.0" });
  client = next; // A failed connect must still close its transport.
  await next.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${agentKey}` } },
  }), { timeout: 30_000 });
  await next.ping({ timeout: 30_000 });
  return next;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  assert(client, "MCP client is not connected.");
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  assert(!result.isError, `${name} returned an execution error.`);
  assert(Array.isArray(result.content), `${name} must return content.`);
  const text = result.content.find((part: unknown) => record(part, "content").type === "text");
  assert(text && typeof text.text === "string", `${name} must return text content.`);
  return record(JSON.parse(text.text), name);
}

async function rest(path: string, method = "GET", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/agent-memory-api${path}`, {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${adminKey}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, 200, `${method} ${path} failed with HTTP ${response.status}.`);
  return record(await response.json(), "REST response");
}

const recallArgs = {
  schema_version: "openbrain.agent_memory.recall.v1",
  workspace_id: workspaceId,
  project_id: projectId,
  query: sample,
  task_id: runId,
  runtime: { name: "ob1-mcp-smoke", version: "1.0.0" },
  limits: { max_items: 10 },
};

async function recallEvidence(): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const recalled = await call("recall_memory", { ...recallArgs, scope: { project_only: true, include_unconfirmed: true } });
    const rows = memories(recalled);
    if (rows.some((memory) => createdIds.has(String(memory.memory_id)))) {
      for (const memory of rows) assertEvidence(memory);
      return recalled;
    }
    if (attempt < 4) await delay(1000);
  }
  throw new Error("Generated smoke memory not visible after bounded vector-index polling.");
}

async function main(): Promise<void> {
  let runError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    stage = "MCP initialize and tool listing";
    const connected = await connect();
    const listing = await connected.listTools(undefined, { timeout: 30_000 });
    assert.deepEqual(listing.tools.map((tool) => tool.name).sort(), [
      "search", "fetch", "search_thoughts", "list_thoughts", "thought_stats", "capture_thought",
      "recall_memory", "writeback_memory", "report_memory_usage",
    ].sort());
    checks.push("SDK initialize, ping, nine advertised tools");

    stage = "pending writeback and idempotent replay";
    const writeArgs = {
      schema_version: "openbrain.agent_memory.writeback.v1",
      workspace_id: workspaceId,
      project_id: projectId,
      task_id: runId,
      idempotency_key: runId,
      runtime: recallArgs.runtime,
      models_used: [],
      source_refs: [{ kind: "verification", uri: "https://natebjones.com", title: "Nate B. Jones / OB1 isolated MCP smoke", timestamp: new Date().toISOString() }],
      memory_payload: { decisions: [sample], outputs: [], lessons: [], constraints: [], unresolved_questions: [], next_steps: [], failures: [], artifacts: [], entities: {} },
      provenance: { default_status: "generated", confidence: 0.8, requires_review: true },
      retention: { ttl_days: 1, stale_after_days: 1 },
      visibility: {},
    };
    const first = memories(await call("writeback_memory", writeArgs));
    for (const memory of first) createdIds.add(ownedMemoryId(memory));
    for (const memory of first) assertEvidence(memory);
    assert.equal(first.length, 1, "Smoke must create exactly one memory.");
    const replay = memories(await call("writeback_memory", writeArgs));
    for (const memory of replay) createdIds.add(ownedMemoryId(memory));
    for (const memory of replay) assertEvidence(memory);
    assert.deepEqual(replay.map((memory) => memory.memory_id), first.map((memory) => memory.memory_id));
    checks.push("generated pending evidence, idempotent replay returns same memory ID");

    stage = "default and explicit evidence recall";
    const pending = await recallEvidence();
    assert.equal(memories(await call("recall_memory", recallArgs)).length, 0, "Default recall must exclude pending evidence.");
    assert(typeof pending.request_id === "string" && pending.request_id, "Recall must include request ID.");
    const usage = await call("report_memory_usage", { workspace_id: workspaceId, request_id: pending.request_id, used_memory_ids: [...createdIds], ignored: [] });
    assert.equal(usage.ok, true);
    checks.push("default excludes pending; explicit evidence recall preserves policy; workspace usage reported");

    stage = "fresh SDK connection persistence";
    await client?.close();
    client = undefined;
    await connect();
    const fresh = await recallEvidence();
    assert.deepEqual(memories(fresh).map((memory) => memory.memory_id), [...createdIds]);
    checks.push("fresh SDK connection recalls same evidence with unchanged use policy");
  } catch (error) {
    runError = error;
  } finally {
    // Recover a committed write whose MCP response was lost; only this unique scope and exact sample qualify.
    try {
      const query = new URLSearchParams({ workspace_id: workspaceId, project_id: projectId, limit: "200" });
      for (const memory of memories(await rest(`/memories?${query}`))) createdIds.add(ownedMemoryId(memory));
    } catch (error) { cleanupErrors.push(error); }
    for (const id of createdIds) {
      try {
        await rest(`/memories/${encodeURIComponent(id)}/review`, "PATCH", {
          action: "reject", actor_label: "OB1 MCP smoke cleanup", notes: "Isolated generated verification sample; reject after test, never confirm.",
        });
      } catch (error) { cleanupErrors.push(error); }
    }
    try { await client?.close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (runError || cleanupErrors.length) {
    console.error(JSON.stringify({ ok: false, stage, workspace_id: workspaceId, project_id: projectId, cleanup_failed: cleanupErrors.length > 0, recorded_memory_ids: [...createdIds] }));
    throw new Error(`Memory MCP smoke failed at ${stage}${cleanupErrors.length ? "; cleanup incomplete: inspect isolated scope before retry" : ""}.`);
  }
  console.log(JSON.stringify({ ok: true, endpoint: `${baseUrl}/mcp`, workspace_id: workspaceId, project_id: projectId, checks, rejected_memory_ids: [...createdIds], cleanup: "rejection, not deletion; memory records, audit events and recall traces persist" }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Memory MCP smoke failed.");
  process.exitCode = 1;
});
