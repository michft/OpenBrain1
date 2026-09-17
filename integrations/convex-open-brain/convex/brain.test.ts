/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { extractMetadata } from "./lib/openrouter";

vi.mock("./lib/openrouter", async (importOriginal) => ({
  ...await importOriginal<typeof import("./lib/openrouter")>(),
  getEmbedding: vi.fn(async () => [1, ...Array<number>(1535).fill(0)]),
  extractMetadata: vi.fn(async () => ({ type: "observation" })),
}));
const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);
afterEach(() => vi.clearAllMocks());

describe("capture metadata", () => {
  it("drops unsupported model fields before calling the validated mutation", async () => {
    const t = convexTest(schema, modules);
    vi.mocked(extractMetadata).mockResolvedValueOnce({
      type: "idea", source: "model", importance: 60, quality_score: 80,
      sensitivity_tier: "standard", topics: ["deployment"],
      flat: { note: "accepted", values: [1, null] }, records: [{ label: "accepted" }],
      nested: { inner: { invalid: true } }, mixed: [1, { label: "invalid" }],
      $invalid: "key", unicodeKey: { "☃": "invalid key" },
      "control\nkey": "invalid key", ["x".repeat(1025)]: "overlong key",
    });
    const capture = await t.action(internal.brain.captureThought, { content: "Capture safe metadata" });
    const row = await t.run((ctx) => ctx.db.get("thoughts", capture.thought_id));
    expect(row).toMatchObject({ type: "idea", sourceType: "model", importance: 60, qualityScore: 80 });
    expect(row?.metadata).toEqual({
      type: "idea", source: "model", source_type: "model", importance: 60, quality_score: 80,
      sensitivity_tier: "standard", topics: ["deployment"],
      flat: { note: "accepted", values: [1, null] }, records: [{ label: "accepted" }],
    });
  });

  it.each([null, [], "invalid", { nested: { inner: { invalid: true } } }])("uses fallback when model metadata has no supported fields: %j", async (extracted) => {
    const t = convexTest(schema, modules);
    vi.mocked(extractMetadata).mockResolvedValueOnce(extracted);
    const capture = await t.action(internal.brain.captureThought, { content: "Review the Convex deployment" });
    const row = await t.run((ctx) => ctx.db.get("thoughts", capture.thought_id));
    expect(row).toMatchObject({ type: "task", metadata: { topics: ["Convex"] } });
  });
});

it("rejects malformed, wrong-table, and missing thought IDs without touching other records", async () => {
  const t = convexTest(schema, modules);
  const capture = await t.action(internal.brain.captureThought, { content: "Keep this thought" });
  const reflection = await t.mutation(internal.brain.addReflection, { thoughtId: capture.thought_id });
  await t.mutation(internal.brain.deleteThought, { id: capture.thought_id });
  for (const id of ["bad-id", reflection.id, capture.thought_id]) {
    expect(await t.query(internal.brain.getThought, { id })).toBeNull();
    await expect(t.mutation(internal.brain.updateThought, { id, content: "wrong target" })).rejects.toThrow("Thought not found");
    await expect(t.mutation(internal.brain.deleteThought, { id })).rejects.toThrow("Thought not found");
    await expect(t.mutation(internal.brain.addReflection, { thoughtId: id })).rejects.toThrow("Thought not found");
  }
  expect(await t.query(internal.brain.reflections, { thoughtId: "bad-id" })).toEqual({ reflections: [] });
  expect(await t.run((ctx) => ctx.db.get("reflections", reflection.id))).not.toBeNull();
});
