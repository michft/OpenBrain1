import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { compactFingerprint } from "./lib/format";

vi.mock("./lib/openrouter", () => ({
  getEmbedding: vi.fn(async () => [1, ...Array<number>(1535).fill(0)]),
  extractMetadata: vi.fn(async () => ({})),
}));

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

afterEach(() => vi.unstubAllEnvs());

function makeTest() {
  return convexTest(schema, modules);
}

function thought(content: string, createdAt: string) {
  return {
    content,
    metadata: {},
    embedding: [0],
    type: "observation",
    sourceType: "test",
    importance: 50,
    qualityScore: 70,
    sensitivityTier: "standard",
    status: null,
    statusUpdatedAt: null,
    contentFingerprint: compactFingerprint(content),
    createdAt,
    updatedAt: createdAt,
  };
}

describe("duplicates", () => {
  it("does not report exact duplicates from stale stored fingerprints", async () => {
    const t = makeTest();
    const recent = new Date().toISOString();
    await t.run(async (ctx) => {
      await ctx.db.insert("thoughts", thought("alpha beta gamma", recent));
      await ctx.db.insert("thoughts", { ...thought("different current content", recent), contentFingerprint: "alpha beta gamma" });
      await ctx.db.insert("thoughts", {
        ...thought("unrelated older content", new Date(Date.now() - 91 * 86400_000).toISOString()),
        contentFingerprint: "alpha beta gamma",
      });
    });
    expect((await t.query(internal.brain.duplicates, { threshold: 1 })).pairs).toEqual([]);
  });

  it("scans only the recent bounded window and reports truncation", async () => {
    const t = makeTest();
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let index = 0; index < 201; index += 1) {
        const createdAt = new Date(now - index * 1000).toISOString();
        await ctx.db.insert("thoughts", thought(`recententry${index}`, createdAt));
      }
      await ctx.db.insert("thoughts", thought("old thought", new Date(now - 91 * 24 * 60 * 60 * 1000).toISOString()));
    });

    const result = await t.query(internal.brain.duplicates, {});

    expect(result.candidate_count).toBe(200);
    expect(result.truncated).toBe(true);
    expect(result.window_start).toEqual(expect.any(String));
    expect(result.pairs).toEqual([]);
  });

  it("preserves threshold and offset pagination for exact and similar matches", async () => {
    const t = makeTest();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("thoughts", thought("alpha beta gamma", new Date(now - 3000).toISOString()));
      await ctx.db.insert("thoughts", thought("alpha beta gamma!", new Date(now - 2000).toISOString()));
      await ctx.db.insert("thoughts", thought("alpha beta delta", new Date(now - 1000).toISOString()));
    });

    const exact = await t.query(internal.brain.duplicates, { threshold: 0.9 });
    expect(exact.pairs).toHaveLength(1);
    expect(exact.pairs[0].similarity).toBe(1);

    const aboveExact = await t.query(internal.brain.duplicates, { threshold: 1.01 });
    expect(aboveExact.pairs).toEqual([]);

    const paged = await t.query(internal.brain.duplicates, { threshold: 0.4, limit: 1, offset: 1 });
    expect(paged.limit).toBe(1);
    expect(paged.offset).toBe(1);
    expect(paged.pairs).toHaveLength(1);
    expect(paged.pairs[0].similarity).toBeGreaterThanOrEqual(0.4);
  });

  it("finds one older exact representative without scanning old fuzzy rows", async () => {
    const t = makeTest();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("thoughts", thought("imported exact thought", new Date(now - 91 * 24 * 60 * 60 * 1000).toISOString()));
      await ctx.db.insert("thoughts", thought("imported exact thought", new Date(now - 1000).toISOString()));
      await ctx.db.insert("thoughts", thought("imported exact thought with extra words", new Date(now - 92 * 24 * 60 * 60 * 1000).toISOString()));
    });

    const result = await t.query(internal.brain.duplicates, {});

    expect(result.candidate_count).toBe(1);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0].similarity).toBe(1);
  });
});
