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
type TestBackend = ReturnType<typeof makeTest>;
type WritebackArgs = FunctionArgs<typeof internal.agentMemory.writeback>;

function makeTest() {
  return convexTest(schema, modules);
}

function writebackArgs(overrides: Partial<WritebackArgs> = {}): WritebackArgs {
  return {
    schema_version: "openbrain.openclaw.writeback.v1",
    workspace_id: "workspace-test",
    project_id: "project-test",
    task_id: "task-test",
    flow_id: "flow-test",
    step_id: "step-test",
    idempotency_key: null,
    content_hash: null,
    channel: { kind: "test", id: "channel-test", thread_id: null },
    runtime: { name: "test-runtime", version: "1" },
    models_used: [],
    source_refs: [],
    memory_payload: {
      decisions: ["Keep the test memory evidence-only until reviewed."],
      outputs: [],
      lessons: [],
      constraints: [],
      unresolved_questions: [],
      next_steps: [],
      failures: [],
      artifacts: [],
      entities: {},
    },
    provenance: { default_status: "generated", confidence: 0.8, requires_review: true },
    retention: { ttl_days: null, stale_after_days: null },
    visibility: {},
    ...overrides,
  };
}

function httpWriteback(t: TestBackend, body: WritebackArgs, key = agentKey): Promise<Response> {
  return t.fetch("/agent-memory-api/writeback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-brain-key": key },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("MCP_ACCESS_KEY", agentKey);
  vi.stubEnv("MCP_ADMIN_KEY", adminKey);
});

afterEach(() => vi.unstubAllEnvs());

describe("agent memory writeback trust", () => {
  it.each(["user_confirmed", "imported"])("downgrades an untrusted %s claim", async (status) => {
    const t = makeTest();
    const result = await t.action(internal.agentMemory.writeback, writebackArgs({
      provenance: { default_status: status, confidence: 1, requires_review: false },
    }));

    expect("memories" in result).toBe(true);
    const memories = await t.run((ctx) => ctx.db.query("agentMemories").collect());
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      provenanceStatus: "generated",
      canUseAsInstruction: false,
      canUseAsEvidence: true,
      requiresUserConfirmation: true,
      reviewStatus: "pending",
      lastConfirmedAt: null,
    });
  });

  it.each(["imported", "user_confirmed"])("allows trusted %s policy", async (status) => {
    const t = makeTest();
    const result = await t.action(internal.agentMemory.writeback, writebackArgs({
      trusted_writeback: true,
      provenance: { default_status: status, confidence: 1, requires_review: false },
    }));

    expect("memories" in result).toBe(true);
    const memories = await t.run((ctx) => ctx.db.query("agentMemories").collect());
    expect(memories[0]).toMatchObject({
      provenanceStatus: status,
      createdBy: status === "imported" ? "import" : "agent",
      canUseAsInstruction: true,
      canUseAsEvidence: true,
      requiresUserConfirmation: false,
      reviewStatus: "confirmed",
    });
  });

  it("keeps generated memories evidence-only even when trusted", async () => {
    const t = makeTest();
    await t.action(internal.agentMemory.writeback, writebackArgs({
      trusted_writeback: true,
      provenance: { default_status: "generated", confidence: 1, requires_review: false },
    }));

    const memories = await t.run((ctx) => ctx.db.query("agentMemories").collect());
    expect(memories[0]).toMatchObject({
      provenanceStatus: "generated",
      canUseAsInstruction: false,
      canUseAsEvidence: true,
      requiresUserConfirmation: true,
      reviewStatus: "pending",
    });
  });

  it("lets only the admin key enable trusted writeback and review", async () => {
    const t = makeTest();
    const body = writebackArgs({
      trusted_writeback: true,
      provenance: { default_status: "imported", confidence: 1, requires_review: false },
    });

    expect((await httpWriteback(t, body)).status).toBe(200);
    let memories = await t.run((ctx) => ctx.db.query("agentMemories").collect());
    expect(memories[0]).toMatchObject({ provenanceStatus: "generated", reviewStatus: "pending" });
    const pendingId = memories[0]._id;

    const adminResponse = await httpWriteback(t, { ...body, idempotency_key: "admin-writeback" }, adminKey);
    expect(adminResponse.status).toBe(200);
    memories = await t.run((ctx) => ctx.db.query("agentMemories").collect());
    const imported = memories.find((memory) => memory.idempotencyKey === "admin-writeback:0");
    expect(imported).toMatchObject({
      provenanceStatus: "imported",
      canUseAsInstruction: true,
      reviewStatus: "confirmed",
    });
    if (!imported) throw new Error("Admin writeback did not create a memory");

    const agentReview = await t.fetch(`/agent-memory-api/memories/${pendingId}/review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-brain-key": agentKey },
      body: JSON.stringify({ action: "confirm" }),
    });
    expect(agentReview.status).toBe(403);
    expect(await t.run((ctx) => ctx.db.get(pendingId))).toMatchObject({ reviewStatus: "pending", canUseAsInstruction: false });

    const adminReview = await t.fetch(`/agent-memory-api/memories/${pendingId}/review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-brain-key": adminKey },
      body: JSON.stringify({ action: "confirm" }),
    });
    expect(adminReview.status).toBe(200);
    expect(await t.run((ctx) => ctx.db.get(pendingId))).toMatchObject({ reviewStatus: "confirmed", canUseAsInstruction: true });
  });

  it("does not elevate when agent and admin keys are equal", async () => {
    vi.stubEnv("MCP_ADMIN_KEY", agentKey);
    const t = makeTest();
    const body = writebackArgs({
      trusted_writeback: true,
      provenance: { default_status: "imported", confidence: 1, requires_review: false },
    });

    expect((await httpWriteback(t, body, agentKey)).status).toBe(200);
    const memories = await t.run((ctx) => ctx.db.query("agentMemories").collect());
    expect(memories[0]).toMatchObject({ provenanceStatus: "generated", reviewStatus: "pending" });
    const review = await t.fetch(`/agent-memory-api/memories/${memories[0]._id}/review`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-brain-key": agentKey },
      body: JSON.stringify({ action: "confirm" }),
    });
    expect(review.status).toBe(403);
  });

  it.each([
    ["api key", "password: abcdefghijklmnop"],
    ["transcript", Array.from({ length: 9 }, (_, index) => `${index % 2 ? "assistant" : "user"}: message ${index}`).join("\n")],
  ])("preserves unsafe %s rejection", async (_kind, content) => {
    const t = makeTest();
    const result = await t.action(internal.agentMemory.writeback, writebackArgs({
      memory_payload: {
        decisions: [content],
        outputs: [],
        lessons: [],
        constraints: [],
        unresolved_questions: [],
        next_steps: [],
        failures: [],
        artifacts: [],
        entities: {},
      },
    }));

    expect(result).toMatchObject({ error: "Unsafe write-back blocked" });
    expect(await t.run((ctx) => ctx.db.query("agentMemories").collect())).toEqual([]);
  });
});
