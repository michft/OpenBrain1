/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

vi.mock("./lib/openrouter", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/openrouter")>(),
  getEmbedding: vi.fn(async () => [1, ...Array<number>(1535).fill(0)]),
  extractMetadata: vi.fn(async () => ({ type: "observation", topics: ["test"] })),
}));

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
const accessKey = "rest-test-key";
const adminKey = "rest-admin-key";
type TestBackend = ReturnType<typeof makeTest>;

function makeTest() {
  return convexTest(schema, modules);
}

function headers(key = accessKey): Record<string, string> {
  return { "content-type": "application/json", "x-brain-key": key };
}

function memoryWriteback(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "openbrain.openclaw.writeback.v1",
    workspace_id: "rest-workspace",
    project_id: "rest-project",
    task_id: "rest-task",
    flow_id: "rest-flow",
    step_id: "rest-step",
    idempotency_key: `rest-${crypto.randomUUID()}`,
    content_hash: null,
    channel: { kind: "test", id: "rest-channel", thread_id: null },
    runtime: { name: "rest-runtime", version: "1" },
    models_used: [],
    source_refs: [],
    memory_payload: {
      decisions: ["A REST test memory"],
      outputs: [], lessons: [], constraints: [], unresolved_questions: [], next_steps: [], failures: [], artifacts: [], entities: {},
    },
    provenance: { default_status: "generated", confidence: 0.8, requires_review: true },
    retention: { ttl_days: null, stale_after_days: null },
    visibility: {},
    ...overrides,
  };
}

async function writeMemory(t: TestBackend, overrides: Record<string, unknown> = {}) {
  await t.action(internal.agentMemory.writeback, memoryWriteback(overrides));
  const rows = await t.run((ctx) => ctx.db.query("agentMemories").collect());
  return rows.at(-1)!;
}

beforeEach(() => {
  vi.stubEnv("MCP_ACCESS_KEY", accessKey);
  vi.stubEnv("MCP_ADMIN_KEY", adminKey);
});

afterEach(() => vi.unstubAllEnvs());

describe("REST path identity", () => {
  it("uses URL thought ID for PUT and reflection POST", async () => {
    const t = makeTest();
    const first = await t.action(internal.brain.captureThought, { content: "First REST thought" });
    const second = await t.action(internal.brain.captureThought, { content: "Second REST thought" });

    const update = await t.fetch(`/open-brain-rest/thought/${first.thought_id}`, {
      method: "PUT", headers: headers(), body: JSON.stringify({ id: second.thought_id, content: "Updated first thought" }),
    });
    expect(update.status).toBe(200);
    expect((await t.run((ctx) => ctx.db.get("thoughts", first.thought_id)))?.content).toBe("Updated first thought");
    expect((await t.run((ctx) => ctx.db.get("thoughts", second.thought_id)))?.content).toBe("Second REST thought");

    const reflection = await t.fetch(`/open-brain-rest/thought/${first.thought_id}/reflection`, {
      method: "POST", headers: headers(), body: JSON.stringify({ thoughtId: second.thought_id, conclusion: "First reflection" }),
    });
    expect(reflection.status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("reflections").collect())).toEqual([
      expect.objectContaining({ thoughtId: first.thought_id, conclusion: "First reflection" }),
    ]);
  });

  it("uses URL request and memory IDs for usage and review", async () => {
    const t = makeTest();
    const memory = await writeMemory(t);
    const recall = await t.action(internal.agentMemory.recall, {
      schema_version: "openbrain.openclaw.recall.v1",
      workspace_id: "rest-workspace",
      query: "REST memory",
      scope: { include_unconfirmed: true },
    });
    const usage = await t.fetch(`/agent-memory-api/recall/${recall.request_id}/usage`, {
      method: "POST", headers: headers(), body: JSON.stringify({ request_id: "forged-request", used_memory_ids: [String(memory._id)], ignored: [] }),
    });
    expect(usage.status).toBe(200);
    const items = await t.run((ctx) => ctx.db.query("agentMemoryRecallItems").collect());
    expect(items).toHaveLength(1);
    expect(items[0].used).toBe(true);

    const second = await writeMemory(t, { idempotency_key: "review-target" });
    const review = await t.fetch(`/agent-memory-api/memories/${memory._id}/review`, {
      method: "PATCH", headers: headers(adminKey), body: JSON.stringify({ id: second._id, action: "confirm" }),
    });
    expect(review.status).toBe(200);
    expect((await t.run((ctx) => ctx.db.get("agentMemories", memory._id)))?.reviewStatus).toBe("confirmed");
    expect((await t.run((ctx) => ctx.db.get("agentMemories", second._id)))?.reviewStatus).toBe("pending");
  });
});

describe("REST memory pagination", () => {
  it.each(["memories", "memories/review"])("bounds sparse scans and resumes without dropping matches: %s", async (path) => {
    const t = makeTest();
    const older = await writeMemory(t);
    for (let index = 0; index < 25; index += 1) await writeMemory(t, { project_id: "other" });
    const newer = await writeMemory(t);
    const url = `/agent-memory-api/${path}?workspace_id=rest-workspace&project_id=rest-project&limit=2`;
    const first = await (await t.fetch(url, { headers: headers() })).json();
    expect(first).toMatchObject({ count: 1, is_done: false, scan_limited: true });
    expect(first.memories.map((memory: { memory_id: string }) => memory.memory_id)).toEqual([newer._id]);
    const second = await (await t.fetch(`${url}&cursor=${encodeURIComponent(first.continue_cursor)}`, { headers: headers() })).json();
    expect(second).toMatchObject({ count: 1, is_done: true, scan_limited: false, continue_cursor: null });
    expect(second.memories.map((memory: { memory_id: string }) => memory.memory_id)).toEqual([older._id]);
  });

  it("fills filtered memories across pages without duplicates", async () => {
    const t = makeTest();
    const matchingIds: string[] = [];
    for (const projectId of ["rest-project", "other", "rest-project", "other", "rest-project", "other"]) {
      const row = await writeMemory(t, { project_id: projectId });
      if (projectId === "rest-project") matchingIds.unshift(row._id);
    }
    const response = await t.fetch("/agent-memory-api/memories?workspace_id=rest-workspace&project_id=rest-project&limit=2", { headers: headers() });
    expect(response.status).toBe(200);
    const body = await response.json() as { memories: Array<{ memory_id: string; scope: { project_id: string | null } }>; count: number; continue_cursor: string | null; is_done: boolean };
    expect(body.count).toBe(2);
    expect(body.memories).toHaveLength(2);
    expect(new Set(body.memories.map((memory) => memory.memory_id)).size).toBe(2);
    expect(body.memories.every((memory) => memory.scope.project_id === "rest-project")).toBe(true);
    expect(body.memories.map((memory) => memory.memory_id)).toEqual(matchingIds.slice(0, 2));
    expect(body.continue_cursor).toEqual(expect.any(String));
    expect(body.is_done).toBe(false);
    const resumed = await t.fetch(`/agent-memory-api/memories?workspace_id=rest-workspace&project_id=rest-project&limit=2&cursor=${encodeURIComponent(body.continue_cursor!)}`, { headers: headers() });
    const resumedBody = await resumed.json() as { memories: Array<{ memory_id: string }>; continue_cursor: string | null; is_done: boolean };
    expect(resumedBody.memories.map((memory) => memory.memory_id)).toEqual(matchingIds.slice(2));
    expect(resumedBody.continue_cursor).toBeNull();
    expect(resumedBody.is_done).toBe(true);
  });

  it("fills the review queue across pages and rejects invalid limits", async () => {
    const t = makeTest();
    for (const projectId of ["other", "rest-project", "other", "rest-project", "other"]) {
      await writeMemory(t, { project_id: projectId });
    }
    const response = await t.fetch("/agent-memory-api/memories/review?workspace_id=rest-workspace&project_id=rest-project&limit=2", { headers: headers() });
    expect(response.status).toBe(200);
    const body = await response.json() as { memories: Array<{ scope: { project_id: string | null } }>; count: number; continue_cursor: string | null; is_done: boolean };
    expect(body.count).toBe(2);
    expect(body.memories.every((memory) => memory.scope.project_id === "rest-project")).toBe(true);
    expect(body.continue_cursor).toEqual(expect.any(String));
    expect(body.is_done).toBe(false);
    const resumed = await t.fetch(`/agent-memory-api/memories/review?workspace_id=rest-workspace&project_id=rest-project&limit=2&cursor=${encodeURIComponent(body.continue_cursor!)}`, { headers: headers() });
    const resumedBody = await resumed.json() as { memories: unknown[]; continue_cursor: string | null; is_done: boolean };
    expect(resumedBody.memories).toEqual([]);
    expect(resumedBody.continue_cursor).toBeNull();
    expect(resumedBody.is_done).toBe(true);

    for (const path of ["/agent-memory-api/memories?workspace_id=rest-workspace&limit=0", "/agent-memory-api/memories/review?workspace_id=rest-workspace&limit=201"]) {
      expect((await t.fetch(path, { headers: headers() })).status).toBe(400);
    }
  });
});

it("returns 404 for malformed and wrong-table memory IDs", async () => {
  const t = makeTest();
  const thought = await t.action(internal.brain.captureThought, { content: "Not a memory" });
  for (const id of ["bad-id", thought.thought_id]) {
    const response = await t.fetch(`/agent-memory-api/memories/${id}`, { headers: headers() });
    expect(response.status).toBe(404);
  }
});
