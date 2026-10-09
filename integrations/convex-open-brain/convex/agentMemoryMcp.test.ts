/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { FunctionArgs } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

vi.mock("./lib/openrouter", () => ({
  getEmbedding: vi.fn(async () => [1, ...Array<number>(1535).fill(0)]),
  extractMetadata: vi.fn(async () => ({ type: "observation", topics: ["test"] })),
}));

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const agentKey = "test-agent-key";
const adminKey = "test-admin-key";
const makeTest = () => convexTest(schema, modules);
type TestBackend = ReturnType<typeof makeTest>;
type WritebackArgs = FunctionArgs<typeof internal.agentMemory.writeback>;

function writebackArgs(overrides: Partial<WritebackArgs> = {}): WritebackArgs {
  return {
    schema_version: "openbrain.agent_memory.writeback.v1",
    workspace_id: "workspace-test",
    project_id: "project-test",
    task_id: "task-test",
    flow_id: "flow-test",
    step_id: "step-test",
    runtime: { name: "t3-code", version: "1" },
    channel: { kind: "thread", id: "channel-test", thread_id: "thread-test" },
    models_used: [{ provider: "CLIProxyAPI", model: "test-model", role: "agent" }],
    source_refs: [{ kind: "decision", uri: "https://example.com/decision", title: "Reviewed decision", timestamp: "2026-10-09T00:00:00Z" }],
    memory_payload: {
      decisions: ["Keep MCP writeback pending until human review."],
      outputs: [], lessons: [], constraints: [], unresolved_questions: [], next_steps: [], failures: [], artifacts: [], entities: {},
    },
    provenance: { default_status: "generated", confidence: 0.8, requires_review: true },
    retention: { ttl_days: null, stale_after_days: null },
    visibility: {},
    ...overrides,
  };
}

function call(t: TestBackend, name: string, args: Record<string, unknown>, key = agentKey) {
  return t.fetch("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

async function confirmedMemory(t: TestBackend, overrides: Partial<WritebackArgs> = {}) {
  const result = await t.action(internal.agentMemory.writeback, writebackArgs(overrides));
  if (!("memories" in result)) throw new Error(result.error);
  const id = result.memories[0].memory_id;
  await t.mutation(internal.agentMemory.reviewMemory, { id, action: "confirm" });
  return id;
}

beforeEach(() => {
  vi.stubEnv("MCP_ACCESS_KEY", agentKey);
  vi.stubEnv("MCP_ADMIN_KEY", adminKey);
});
afterEach(() => vi.unstubAllEnvs());

describe("Agent Memory over MCP", () => {
  it.each([
    [agentKey, "user_confirmed"], [adminKey, "user_confirmed"], [agentKey, "imported"], [adminKey, "imported"],
  ])("keeps forged trusted writeback pending with key %s and provenance %s; retries idempotently", async (key, status) => {
    const t = makeTest();
    const args = writebackArgs({
      idempotency_key: "mcp-milestone",
      trusted_writeback: true,
      provenance: { default_status: status, confidence: 1, requires_review: false },
    });
    const first = await (await call(t, "writeback_memory", args, key)).json();
    const second = await (await call(t, "writeback_memory", args, key)).json();
    expect(first.error).toBeUndefined();
    expect(first.result.isError).not.toBe(true);
    const response = JSON.parse(first.result.content[0].text);
    expect(response.schema_version).toBe("openbrain.agent_memory.writeback_response.v1");
    expect(JSON.parse(second.result.content[0].text).memories[0].memory_id).toBe(response.memories[0].memory_id);
    expect(response.memories[0].use_policy).toMatchObject({
      can_use_as_instruction: false, can_use_as_evidence: true, requires_user_confirmation: true,
    });
    const rows = await t.run((ctx) => ctx.db.query("agentMemories").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspaceId: "workspace-test", projectId: "project-test", taskId: "task-test", flowId: "flow-test",
      runtimeName: "t3-code", provider: "CLIProxyAPI", model: "test-model", channelThreadId: "thread-test",
      provenanceStatus: "generated", reviewStatus: "pending", canUseAsInstruction: false,
    });
    expect(await t.run((ctx) => ctx.db.query("agentMemorySourceRefs").collect())).toMatchObject([
      { sourceKind: "decision", uri: "https://example.com/decision", title: "Reviewed decision" },
    ]);
  });

  it("recalls scoped records, preserves policy, and reports usage only in the trace workspace", async () => {
    const t = makeTest();
    const confirmedId = await confirmedMemory(t);
    await confirmedMemory(t, { workspace_id: "other-workspace" });
    await confirmedMemory(t, { project_id: "other-project" });
    await confirmedMemory(t, { project_id: null });
    const pending = await t.action(internal.agentMemory.writeback, writebackArgs({ idempotency_key: "pending" }));
    if (!("memories" in pending)) throw new Error(pending.error);
    const staleId = await confirmedMemory(t, { idempotency_key: "stale" });
    await t.mutation(internal.agentMemory.reviewMemory, { id: staleId, action: "mark_stale" });
    const args = {
      schema_version: "openbrain.agent_memory.recall.v1", workspace_id: "workspace-test", project_id: "project-test",
      query: "MCP writeback review", task_id: "recall-task", flow_id: "recall-flow",
      runtime: { name: "t3-code", version: "1" }, channel: { kind: "thread", id: "recall-channel", thread_id: "recall-thread" },
      limits: { max_items: 10 },
    };
    const rpc = await (await call(t, "recall_memory", args)).json();
    const response = JSON.parse(rpc.result.content[0].text);
    expect(response.schema_version).toBe("openbrain.agent_memory.recall_response.v1");
    expect(response.memories.map((memory: { memory_id: string }) => memory.memory_id)).toEqual([confirmedId]);
    expect(response.memories[0].use_policy).toMatchObject({ can_use_as_instruction: true, requires_user_confirmation: false });
    const trace = await t.query(internal.agentMemory.recallTrace, { request_id: response.request_id });
    expect(trace?.trace).toMatchObject({ workspaceId: "workspace-test", projectId: "project-test", taskId: "recall-task", runtimeName: "t3-code" });
    expect(trace?.trace.requestPayload.channel_thread_id).toBe("recall-thread");
    const usage = { workspace_id: "wrong-workspace", request_id: response.request_id, used_memory_ids: [confirmedId], ignored: [] };
    expect(await (await call(t, "report_memory_usage", usage)).json()).toMatchObject({ error: { code: -32602 } });
    expect((await t.query(internal.agentMemory.recallTrace, { request_id: response.request_id }))?.items[0].used).toBeNull();
    const reported = await (await call(t, "report_memory_usage", { ...usage, workspace_id: "workspace-test" })).json();
    expect(JSON.parse(reported.result.content[0].text)).toEqual({ ok: true });
    expect((await t.query(internal.agentMemory.recallTrace, { request_id: response.request_id }))?.items[0].used).toBe(true);
    const malformedUsage = await (await call(t, "report_memory_usage", { ...usage, workspace_id: "workspace-test", used_memory_ids: [3] })).json();
    expect(malformedUsage.result.isError).toBe(true);
    const ignored = await (await call(t, "report_memory_usage", {
      ...usage, workspace_id: "workspace-test", used_memory_ids: [], ignored: [{ memory_id: confirmedId, reason: "Decision no longer needed" }],
    })).json();
    expect(JSON.parse(ignored.result.content[0].text)).toEqual({ ok: true });
    expect((await t.query(internal.agentMemory.recallTrace, { request_id: response.request_id }))?.items[0])
      .toMatchObject({ used: false, ignoredReason: "Decision no longer needed" });

    const unconfirmedRpc = await (await call(t, "recall_memory", { ...args, scope: { include_unconfirmed: true } })).json();
    const unconfirmed = JSON.parse(unconfirmedRpc.result.content[0].text);
    expect(unconfirmed.memories.map((memory: { memory_id: string }) => memory.memory_id)).toContain(pending.memories[0].memory_id);
    expect(unconfirmed.memories.find((memory: { memory_id: string }) => memory.memory_id === pending.memories[0].memory_id).use_policy)
      .toMatchObject({ can_use_as_instruction: false, can_use_as_evidence: true, requires_user_confirmation: true });
  });

  it("rejects malformed arguments and unsafe content without writing records", async () => {
    const t = makeTest();
    for (const [name, args] of [
      ["recall_memory", { schema_version: "test", workspace_id: " ", query: "test" }],
      ["recall_memory", { schema_version: "test", workspace_id: "workspace-test", query: "test", limits: { max_items: 1.5 } }],
      ["recall_memory", { schema_version: "test", workspace_id: "workspace-test", query: "test", scope: { include_unconfirmed: "true" } }],
      ["writeback_memory", { ...writebackArgs(), memory_payload: { decisions: "invalid" } }],
      ["writeback_memory", { ...writebackArgs(), provenance: { default_status: "generated", confidence: 2, requires_review: true } }],
      ["writeback_memory", { ...writebackArgs(), source_refs: [{ kind: 1 }] }],
      ["report_memory_usage", { workspace_id: "workspace-test", request_id: "missing", used_memory_ids: [], ignored: [] }],
      ["review_memory", { id: "missing", action: "confirm" }],
    ] satisfies Array<[string, Record<string, unknown>]>) {
      const result = await (await call(t, name, args)).json();
      expect(Boolean(result.error || result.result?.isError)).toBe(true);
    }
    const args = writebackArgs();
    args.memory_payload.decisions = ["password: abcdefghijklmnop"];
    const unsafe = await (await call(t, "writeback_memory", args)).json();
    expect(unsafe.result.isError).toBe(true);
    expect(JSON.parse(unsafe.result.content[0].text)).toMatchObject({ error: "Unsafe write-back blocked" });
    expect(await t.run((ctx) => ctx.db.query("agentMemories").collect())).toEqual([]);
  });

  it.each(["recall_memory", "writeback_memory", "report_memory_usage"])("requires authenticated access for %s", async (name) => {
    const t = makeTest();
    expect((await call(t, name, {}, "invalid-key")).status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("agentMemories").collect())).toEqual([]);
  });
});
