import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { compactFingerprint, idFromString, normalizeThought, tokenSimilarity } from "./lib/format";
import { extractMetadata, getEmbedding } from "./lib/openrouter";

const metadataValidator = v.record(v.string(), v.any());

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRestricted(row: Doc<"thoughts">): boolean {
  return row.sensitivityTier === "restricted" || row.metadata.sensitivity_tier === "restricted";
}

function sortRows(rows: Doc<"thoughts">[], sort: string, order: string): Doc<"thoughts">[] {
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortableValue(a, sort);
    const right = sortableValue(b, sort);
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    return a._id.localeCompare(b._id) * direction;
  });
}

function sortableValue(row: Doc<"thoughts">, sort: string): string | number {
  if (sort === "importance") return row.importance;
  if (sort === "quality_score") return row.qualityScore;
  if (sort === "type") return row.type;
  if (sort === "source_type") return row.sourceType;
  if (sort === "status") return row.status ?? "";
  if (sort === "updated_at") return row.updatedAt;
  return row.createdAt;
}

function filterRows(
  rows: Doc<"thoughts">[],
  args: {
    type?: string;
    source_type?: string;
    status?: string;
    importance_min?: number;
    quality_score_max?: number;
    exclude_restricted?: boolean;
  },
): Doc<"thoughts">[] {
  const statuses = args.status?.split(",").map((status) => status.trim()).filter(Boolean);
  return rows.filter((row) => {
    if (args.exclude_restricted !== false && isRestricted(row)) return false;
    if (args.type && row.type !== args.type) return false;
    if (args.source_type && row.sourceType !== args.source_type) return false;
    if (statuses?.length && !statuses.includes(row.status ?? "")) return false;
    if (args.importance_min !== undefined && row.importance < args.importance_min) return false;
    if (args.quality_score_max !== undefined && row.qualityScore > args.quality_score_max) return false;
    return true;
  });
}

export const health = query({
  args: {},
  handler: async () => ({ ok: true, status: "ok", service: "convex-open-brain", version: "0.1.0" }),
});

export const listThoughts = query({
  args: {
    page: v.optional(v.number()),
    per_page: v.optional(v.number()),
    type: v.optional(v.string()),
    source_type: v.optional(v.string()),
    status: v.optional(v.string()),
    importance_min: v.optional(v.number()),
    quality_score_max: v.optional(v.number()),
    sort: v.optional(v.string()),
    order: v.optional(v.string()),
    exclude_restricted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const perPage = Math.min(100, Math.max(1, Math.floor(args.per_page ?? 25)));
    const rows = await ctx.db.query("thoughts").collect();
    const filtered = filterRows(rows, args);
    const sorted = sortRows(filtered, args.sort ?? "created_at", args.order ?? "desc");
    const offset = (page - 1) * perPage;
    return {
      data: sorted.slice(offset, offset + perPage).map((row) => normalizeThought(row)),
      total: sorted.length,
      page,
      per_page: perPage,
    };
  },
});

export const getThought = query({
  args: { id: v.string(), exclude_restricted: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(idFromString(args.id));
    if (!row) return null;
    if (args.exclude_restricted !== false && isRestricted(row)) return { restricted: true };
    return normalizeThought(row);
  },
});

export const fetchThoughtRows = internalQuery({
  args: { ids: v.array(v.id("thoughts")) },
  handler: async (ctx, args) => {
    const rows: Doc<"thoughts">[] = [];
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row) rows.push(row);
    }
    return rows;
  },
});

export const stats = query({
  args: {
    days: v.optional(v.number()),
    exclude_restricted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const since = args.days ? Date.now() - args.days * 24 * 60 * 60 * 1000 : null;
    const rows = (await ctx.db.query("thoughts").collect()).filter((row) => {
      if (args.exclude_restricted !== false && isRestricted(row)) return false;
      if (since && Date.parse(row.createdAt) < since) return false;
      return true;
    });
    const types: Record<string, number> = {};
    const topics: Record<string, number> = {};
    for (const row of rows) {
      types[row.type] = (types[row.type] || 0) + 1;
      const rowTopics = Array.isArray(row.metadata.topics) ? row.metadata.topics : [];
      for (const topic of rowTopics) if (typeof topic === "string") topics[topic] = (topics[topic] || 0) + 1;
    }
    return {
      total_thoughts: rows.length,
      window_days: args.days || "all",
      types,
      top_topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([topic, count]) => ({ topic, count })),
    };
  },
});

export const upsertThought = internalMutation({
  args: {
    content: v.string(),
    metadata: metadataValidator,
    embedding: v.array(v.float64()),
    type: v.string(),
    sourceType: v.string(),
    importance: v.number(),
    qualityScore: v.number(),
    sensitivityTier: v.string(),
    status: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    const fingerprint = compactFingerprint(args.content);
    const existing = await ctx.db
      .query("thoughts")
      .withIndex("by_contentFingerprint", (q) => q.eq("contentFingerprint", fingerprint))
      .unique();
    const payload = {
      content: args.content,
      metadata: args.metadata,
      embedding: args.embedding,
      type: args.type,
      sourceType: args.sourceType,
      importance: args.importance,
      qualityScore: args.qualityScore,
      sensitivityTier: args.sensitivityTier,
      status: args.status ?? null,
      statusUpdatedAt: args.status ? timestamp : null,
      contentFingerprint: fingerprint,
      updatedAt: timestamp,
    };
    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return { id: existing._id, fingerprint, action: "updated" };
    }
    const id = await ctx.db.insert("thoughts", { ...payload, createdAt: timestamp });
    return { id, fingerprint, action: "created" };
  },
});

export const captureThought = action({
  args: {
    content: v.string(),
    metadata: v.optional(metadataValidator),
    type: v.optional(v.string()),
    source_type: v.optional(v.string()),
    importance: v.optional(v.number()),
    quality_score: v.optional(v.number()),
    sensitivity_tier: v.optional(v.string()),
    status: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content) throw new Error("content is required");
    const [embedding, extracted] = await Promise.all([
      getEmbedding(content),
      args.metadata ? Promise.resolve(args.metadata) : extractMetadata(content),
    ]);
    const type = args.type || stringValue(extracted.type, "observation");
    const sourceType = args.source_type || stringValue(extracted.source, "dashboard");
    const status = args.status !== undefined ? args.status : ["task", "idea"].includes(type) ? "new" : null;
    const metadata = {
      ...extracted,
      type,
      source: sourceType,
      source_type: sourceType,
    };
    const result = await ctx.runMutation(internal.brain.upsertThought, {
      content,
      metadata,
      embedding,
      type,
      sourceType,
      importance: args.importance ?? numberValue(extracted.importance, 50),
      qualityScore: args.quality_score ?? numberValue(extracted.quality_score, 70),
      sensitivityTier: args.sensitivity_tier || stringValue(extracted.sensitivity_tier, "standard"),
      status,
    });
    return {
      thought_id: result.id,
      action: result.action === "created" ? "created" : "created_or_updated",
      type,
      sensitivity_tier: args.sensitivity_tier || stringValue(extracted.sensitivity_tier, "standard"),
      content_fingerprint: result.fingerprint,
      message: "Thought captured",
    };
  },
});

export const updateThought = mutation({
  args: {
    id: v.string(),
    content: v.optional(v.string()),
    metadata: v.optional(metadataValidator),
    type: v.optional(v.string()),
    importance: v.optional(v.number()),
    quality_score: v.optional(v.number()),
    sensitivity_tier: v.optional(v.string()),
    status: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const id = idFromString(args.id);
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("Thought not found");
    const timestamp = now();
    const patch: {
      content?: string;
      metadata?: Record<string, unknown>;
      type?: string;
      importance?: number;
      qualityScore?: number;
      sensitivityTier?: string;
      status?: string | null;
      statusUpdatedAt?: string | null;
      updatedAt: string;
    } = {
      metadata: { ...existing.metadata, ...(args.metadata || {}) },
      updatedAt: timestamp,
    };
    if (args.content !== undefined) patch.content = args.content;
    if (args.type !== undefined) {
      patch.type = args.type;
      patch.metadata = { ...patch.metadata, type: args.type };
    }
    if (args.importance !== undefined) patch.importance = args.importance;
    if (args.quality_score !== undefined) patch.qualityScore = args.quality_score;
    if (args.sensitivity_tier !== undefined) patch.sensitivityTier = args.sensitivity_tier;
    if (args.status !== undefined) {
      patch.status = args.status;
      patch.statusUpdatedAt = timestamp;
    }
    await ctx.db.patch(id, patch);
    return { id: args.id, action: "updated", message: "Thought updated" };
  },
});

export const deleteThought = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.delete(idFromString(args.id));
    return { id: args.id, action: "deleted", message: "Thought deleted" };
  },
});

export const semanticSearch = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    page: v.optional(v.number()),
    threshold: v.optional(v.number()),
    exclude_restricted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 25)));
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const embedding = await getEmbedding(args.query);
    const matches = await ctx.vectorSearch("thoughts", "by_embedding", {
      vector: embedding,
      limit: Math.min(256, Math.max(limit * page * 3, limit)),
    });
    const rows = await ctx.runQuery(internal.brain.fetchThoughtRows, { ids: matches.map((match) => match._id) });
    const byId = new Map<Id<"thoughts">, Doc<"thoughts">>(rows.map((row) => [row._id, row]));
    const ordered = matches
      .filter((match) => match._score >= (args.threshold ?? 0.35))
      .map((match, index) => ({ match, row: byId.get(match._id), rank: index + 1 }))
      .filter((item): item is { match: { _id: Id<"thoughts">; _score: number }; row: Doc<"thoughts">; rank: number } => Boolean(item.row))
      .filter((item) => args.exclude_restricted === false || !isRestricted(item.row))
      .map((item) => normalizeThought(item.row, { similarity: item.match._score, rank: item.rank }));
    const offset = (page - 1) * limit;
    return {
      results: ordered.slice(offset, offset + limit),
      count: Math.min(limit, Math.max(0, ordered.length - offset)),
      total: ordered.length,
      page,
      per_page: limit,
      total_pages: Math.max(1, Math.ceil(ordered.length / limit)),
      mode: "semantic",
    };
  },
});

export const textSearch = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    page: v.optional(v.number()),
    exclude_restricted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 25)));
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const q = args.query.toLowerCase();
    const rows = (await ctx.db.query("thoughts").collect())
      .filter((row) => args.exclude_restricted === false || !isRestricted(row))
      .filter((row) => row.content.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = (page - 1) * limit;
    return {
      results: rows.slice(offset, offset + limit).map((row, index) => normalizeThought(row, { rank: offset + index + 1 })),
      count: Math.min(limit, Math.max(0, rows.length - offset)),
      total: rows.length,
      page,
      per_page: limit,
      total_pages: Math.max(1, Math.ceil(rows.length / limit)),
      mode: "text",
    };
  },
});

export const duplicates = query({
  args: {
    threshold: v.optional(v.number()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const threshold = args.threshold ?? 0.85;
    const limit = Math.min(100, Math.max(1, Math.floor(args.limit ?? 50)));
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    const thoughts = await ctx.db.query("thoughts").collect();
    const pairs = [];
    for (let i = 0; i < thoughts.length; i += 1) {
      for (let j = i + 1; j < thoughts.length; j += 1) {
        const a = thoughts[i];
        const b = thoughts[j];
        const exact = compactFingerprint(a.content) === compactFingerprint(b.content);
        const similarity = exact ? 1 : tokenSimilarity(a.content, b.content);
        if (similarity >= threshold) {
          pairs.push({
            thought_id_a: a._id,
            thought_id_b: b._id,
            similarity,
            content_a: a.content,
            content_b: b.content,
            type_a: a.type,
            type_b: b.type,
            quality_a: a.qualityScore,
            quality_b: b.qualityScore,
            created_a: a.createdAt,
            created_b: b.createdAt,
          });
        }
      }
    }
    pairs.sort((a, b) => b.similarity - a.similarity || b.quality_a + b.quality_b - (a.quality_a + a.quality_b));
    return { pairs: pairs.slice(offset, offset + limit), threshold, limit, offset };
  },
});

export const reflections = query({
  args: { thoughtId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("reflections")
      .withIndex("by_thought", (q) => q.eq("thoughtId", idFromString(args.thoughtId)))
      .collect();
    return {
      reflections: rows
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((row) => ({
          id: row._id,
          thought_id: row.thoughtId,
          trigger_context: row.triggerContext,
          options: row.options,
          factors: row.factors,
          conclusion: row.conclusion,
          confidence: row.confidence,
          reflection_type: row.reflectionType,
          metadata: row.metadata,
          created_at: row.createdAt,
        })),
    };
  },
});

export const addReflection = mutation({
  args: {
    thoughtId: v.string(),
    trigger_context: v.optional(v.string()),
    options: v.optional(v.array(v.any())),
    factors: v.optional(v.array(v.any())),
    conclusion: v.optional(v.string()),
    confidence: v.optional(v.number()),
    reflection_type: v.optional(v.string()),
    metadata: v.optional(metadataValidator),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("reflections", {
      thoughtId: idFromString(args.thoughtId),
      triggerContext: args.trigger_context ?? "",
      options: args.options ?? [],
      factors: args.factors ?? [],
      conclusion: args.conclusion ?? "",
      confidence: args.confidence ?? 0.75,
      reflectionType: args.reflection_type ?? "reflection",
      metadata: args.metadata ?? {},
      createdAt: now(),
    });
    return { id };
  },
});
