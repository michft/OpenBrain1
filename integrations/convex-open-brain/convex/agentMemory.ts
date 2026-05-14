import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { memoryIdFromString, responseMemory } from "./lib/format";
import type { PublicMemory } from "./lib/format";
import { getEmbedding } from "./lib/openrouter";

const metadataValidator = v.record(v.string(), v.any());

const runtimeValidator = v.object({
  name: v.string(),
  version: v.optional(v.union(v.string(), v.null())),
});

const channelValidator = v.object({
  kind: v.optional(v.union(v.string(), v.null())),
  id: v.optional(v.union(v.string(), v.null())),
  thread_id: v.optional(v.union(v.string(), v.null())),
});

const sourceRefValidator = v.object({
  kind: v.string(),
  uri: v.optional(v.union(v.string(), v.null())),
  title: v.optional(v.union(v.string(), v.null())),
  timestamp: v.optional(v.union(v.string(), v.null())),
});

const artifactValidator = v.object({
  kind: v.string(),
  uri: v.string(),
  description: v.optional(v.union(v.string(), v.null())),
});

const memoryPayloadValidator = v.object({
  decisions: v.array(v.string()),
  outputs: v.array(v.string()),
  lessons: v.array(v.string()),
  constraints: v.array(v.string()),
  unresolved_questions: v.array(v.string()),
  next_steps: v.array(v.string()),
  failures: v.array(v.string()),
  artifacts: v.array(artifactValidator),
  entities: metadataValidator,
});

type RecallArgs = {
  schema_version: string;
  workspace_id: string;
  project_id?: string | null;
  task_id?: string | null;
  flow_id?: string | null;
  query: string;
  channel?: { kind?: string | null; id?: string | null; thread_id?: string | null };
  runtime?: { name: string; version?: string | null };
  scope?: {
    visibility?: string | null;
    project_only?: boolean;
    include_unconfirmed?: boolean;
    include_stale?: boolean;
  };
  limits?: { max_items?: number; max_tokens?: number; recency_days?: number | null };
};

type MemoryRow = {
  memory_type: string;
  content: string;
};

type VectorMatch<TableName extends "agentMemories"> = {
  _id: Id<TableName>;
  _score: number;
};

type RankedMemory = Doc<"agentMemories"> & {
  similarity: number;
  rankingScore: number;
};

type RecallResponse = {
  schema_version: string;
  request_id: string;
  memories: PublicMemory[];
};

type UnsafeWritebackReason = {
  reason: string;
  memory_type: string;
};

type WritebackResponse =
  | { error: string; unsafe: UnsafeWritebackReason[] }
  | { schema_version: string; memories: PublicMemory[] };

function now(): string {
  return new Date().toISOString();
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unsafeReasons(text: string): string[] {
  const reasons: string[] = [];
  if (/-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/.test(text)) reasons.push("private_key");
  if (/(?:sk-[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9_-]{20,})/.test(text)) reasons.push("api_key");
  if (/(?:password|passwd|secret|token)\s*[:=]\s*\S{12,}/i.test(text)) reasons.push("credential_like_string");
  if ((text.match(/```/g) || []).length >= 4 || text.split("\n").filter((line) => line.length > 120).length > 20) {
    reasons.push("large_code_block");
  }
  if (text.length > 15000 || text.split("\n").filter((line) => /^(user|assistant|system|agent|human):/i.test(line.trim())).length > 8) {
    reasons.push("raw_transcript_like");
  }
  return reasons;
}

function staleAfter(days?: number | null): string | null {
  if (!days) return null;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function memoryRows(payload: {
  decisions: string[];
  outputs: string[];
  lessons: string[];
  constraints: string[];
  unresolved_questions: string[];
  next_steps: string[];
  failures: string[];
  artifacts: Array<{ kind: string; uri: string; description?: string | null }>;
}): MemoryRow[] {
  const rows: MemoryRow[] = [];
  for (const content of payload.decisions) rows.push({ memory_type: "decision", content });
  for (const content of payload.outputs) rows.push({ memory_type: "output", content });
  for (const content of payload.lessons) rows.push({ memory_type: "lesson", content });
  for (const content of payload.constraints) rows.push({ memory_type: "constraint", content });
  for (const content of payload.unresolved_questions) rows.push({ memory_type: "open_question", content });
  for (const content of payload.next_steps) rows.push({ memory_type: "work_log", content: `Next step: ${content}` });
  for (const content of payload.failures) rows.push({ memory_type: "failure", content });
  for (const artifact of payload.artifacts) {
    rows.push({ memory_type: "artifact_reference", content: `${artifact.kind}: ${artifact.description || artifact.uri}\n${artifact.uri}` });
  }
  return rows;
}

function scopeMatches(memory: Doc<"agentMemories">, req: RecallArgs): boolean {
  const scope = req.scope ?? {};
  if (memory.workspaceId !== req.workspace_id) return false;
  if (scope.project_only !== false && req.project_id && memory.projectId !== req.project_id) return false;
  if (scope.include_stale !== true && ["stale", "superseded", "rejected", "disputed"].includes(memory.lifecycleStatus)) return false;
  if (scope.include_unconfirmed !== true && memory.requiresUserConfirmation && memory.reviewStatus === "pending") return false;
  if (memory.visibility === "personal" && scope.visibility !== "personal") return false;
  return true;
}

function rankMemory(memory: Doc<"agentMemories">, similarity = 0): number {
  const provenance = memory.provenanceStatus === "user_confirmed" ? 0.3
    : memory.provenanceStatus === "imported" ? 0.22
      : memory.provenanceStatus === "observed" ? 0.15
        : memory.provenanceStatus === "generated" ? 0.05
          : 0;
  const policy = memory.canUseAsInstruction ? 0.2 : memory.canUseAsEvidence ? 0.08 : -0.2;
  const review = memory.reviewStatus === "confirmed" ? 0.15
    : memory.reviewStatus === "evidence_only" ? 0.05
      : memory.reviewStatus === "pending" ? -0.08
        : -0.25;
  return similarity + provenance + policy + review + memory.confidence * 0.15;
}

function recallResponseSchema(schemaVersion: string): string {
  return schemaVersion === "openbrain.openclaw.recall.v1"
    ? "openbrain.openclaw.recall_response.v1"
    : "openbrain.agent_memory.recall_response.v1";
}

function writebackResponseSchema(schemaVersion: string): string {
  return schemaVersion === "openbrain.openclaw.writeback.v1"
    ? "openbrain.openclaw.writeback_response.v1"
    : "openbrain.agent_memory.writeback_response.v1";
}

export const fetchMemoryRows = internalQuery({
  args: { ids: v.array(v.id("agentMemories")) },
  handler: async (ctx, args) => {
    const rows: Doc<"agentMemories">[] = [];
    for (const id of args.ids) {
      const row = await ctx.db.get(id);
      if (row) rows.push(row);
    }
    return rows;
  },
});

export const insertAudit = internalMutation({
  args: {
    eventType: v.string(),
    workspaceId: v.optional(v.union(v.string(), v.null())),
    projectId: v.optional(v.union(v.string(), v.null())),
    memoryId: v.optional(v.union(v.id("agentMemories"), v.null())),
    traceId: v.optional(v.union(v.id("agentMemoryRecallTraces"), v.null())),
    actorKind: v.optional(v.string()),
    actorLabel: v.optional(v.union(v.string(), v.null())),
    runtimeName: v.optional(v.union(v.string(), v.null())),
    taskId: v.optional(v.union(v.string(), v.null())),
    payload: metadataValidator,
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("agentMemoryAuditEvents", {
      eventType: args.eventType,
      workspaceId: args.workspaceId ?? null,
      projectId: args.projectId ?? null,
      memoryId: args.memoryId ?? null,
      traceId: args.traceId ?? null,
      actorKind: args.actorKind ?? "system",
      actorLabel: args.actorLabel ?? null,
      runtimeName: args.runtimeName ?? null,
      taskId: args.taskId ?? null,
      payload: args.payload,
      createdAt: now(),
    });
  },
});

export const insertRecallTrace = internalMutation({
  args: {
    requestId: v.string(),
    workspaceId: v.string(),
    projectId: v.optional(v.union(v.string(), v.null())),
    runtimeName: v.optional(v.union(v.string(), v.null())),
    runtimeVersion: v.optional(v.union(v.string(), v.null())),
    taskId: v.optional(v.union(v.string(), v.null())),
    flowId: v.optional(v.union(v.string(), v.null())),
    channelKind: v.optional(v.union(v.string(), v.null())),
    channelId: v.optional(v.union(v.string(), v.null())),
    query: v.string(),
    schemaVersion: v.string(),
    requestPayload: metadataValidator,
    responsePolicy: metadataValidator,
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentMemoryRecallTraces", { ...args, createdAt: now() });
  },
});

export const insertRecallItems = internalMutation({
  args: {
    traceId: v.id("agentMemoryRecallTraces"),
    items: v.array(v.object({
      memoryId: v.id("agentMemories"),
      rank: v.number(),
      similarity: v.number(),
      rankingScore: v.number(),
      usePolicySnapshot: metadataValidator,
    })),
  },
  handler: async (ctx, args) => {
    const timestamp = now();
    for (const item of args.items) {
      await ctx.db.insert("agentMemoryRecallItems", { traceId: args.traceId, ...item, used: null, ignoredReason: null, createdAt: timestamp });
    }
  },
});

export const recall = action({
  args: {
    schema_version: v.string(),
    workspace_id: v.string(),
    project_id: v.optional(v.union(v.string(), v.null())),
    task_id: v.optional(v.union(v.string(), v.null())),
    flow_id: v.optional(v.union(v.string(), v.null())),
    query: v.string(),
    channel: v.optional(channelValidator),
    runtime: v.optional(runtimeValidator),
    model_intent: v.optional(metadataValidator),
    entities: v.optional(metadataValidator),
    scope: v.optional(v.object({
      visibility: v.optional(v.union(v.string(), v.null())),
      project_only: v.optional(v.boolean()),
      include_unconfirmed: v.optional(v.boolean()),
      include_stale: v.optional(v.boolean()),
    })),
    limits: v.optional(v.object({
      max_items: v.optional(v.number()),
      max_tokens: v.optional(v.number()),
      recency_days: v.optional(v.union(v.number(), v.null())),
    })),
    sensitivity: v.optional(metadataValidator),
  },
  handler: async (ctx, req): Promise<RecallResponse> => {
    const maxItems = Math.min(50, Math.max(1, Math.floor(req.limits?.max_items ?? 10)));
    const embedding = await getEmbedding(req.query);
    const matches: VectorMatch<"agentMemories">[] = await ctx.vectorSearch("agentMemories", "by_embedding", {
      vector: embedding,
      limit: Math.min(256, Math.max(maxItems * 4, 20)),
      filter: (q) => q.eq("workspaceId", req.workspace_id),
    });
    const rows: Doc<"agentMemories">[] = await ctx.runQuery(internal.agentMemory.fetchMemoryRows, { ids: matches.map((match) => match._id) });
    const byId = new Map<Id<"agentMemories">, Doc<"agentMemories">>(rows.map((row: Doc<"agentMemories">) => [row._id, row]));
    const ranked: RankedMemory[] = matches
      .map((match) => ({ match, memory: byId.get(match._id) }))
      .filter((item): item is { match: VectorMatch<"agentMemories">; memory: Doc<"agentMemories"> } => Boolean(item.memory))
      .filter((item) => scopeMatches(item.memory, req))
      .map((item) => ({ ...item.memory, similarity: item.match._score, rankingScore: rankMemory(item.memory, item.match._score) }))
      .sort((a, b) => b.rankingScore - a.rankingScore)
      .slice(0, maxItems);
    const requestId = crypto.randomUUID();
    const traceId = await ctx.runMutation(internal.agentMemory.insertRecallTrace, {
      requestId,
      workspaceId: req.workspace_id,
      projectId: req.project_id ?? null,
      runtimeName: req.runtime?.name ?? "unknown",
      runtimeVersion: req.runtime?.version ?? null,
      taskId: req.task_id ?? null,
      flowId: req.flow_id ?? null,
      channelKind: req.channel?.kind ?? null,
      channelId: req.channel?.id ?? null,
      query: req.query,
      schemaVersion: req.schema_version,
      requestPayload: req,
      responsePolicy: { max_items: maxItems, include_unconfirmed: req.scope?.include_unconfirmed ?? false },
    });
    await ctx.runMutation(internal.agentMemory.insertRecallItems, {
      traceId,
      items: ranked.map((memory: RankedMemory, index: number) => ({
        memoryId: memory._id,
        rank: index + 1,
        similarity: memory.similarity,
        rankingScore: memory.rankingScore,
        usePolicySnapshot: {
          can_use_as_instruction: memory.canUseAsInstruction,
          can_use_as_evidence: memory.canUseAsEvidence,
          requires_user_confirmation: memory.requiresUserConfirmation,
        },
      })),
    });
    await ctx.runMutation(internal.agentMemory.insertAudit, {
      eventType: "recall_requested",
      workspaceId: req.workspace_id,
      projectId: req.project_id ?? null,
      traceId,
      runtimeName: req.runtime?.name ?? "unknown",
      taskId: req.task_id ?? null,
      payload: { returned_count: ranked.length },
    });
    return {
      schema_version: recallResponseSchema(req.schema_version),
      request_id: requestId,
      memories: ranked.map(responseMemory),
    };
  },
});

export const insertMemory = internalMutation({
  args: {
    thoughtId: v.optional(v.union(v.id("thoughts"), v.null())),
    workspaceId: v.string(),
    projectId: v.optional(v.union(v.string(), v.null())),
    channelKind: v.optional(v.union(v.string(), v.null())),
    channelId: v.optional(v.union(v.string(), v.null())),
    channelThreadId: v.optional(v.union(v.string(), v.null())),
    visibility: v.string(),
    memoryType: v.string(),
    summary: v.string(),
    content: v.string(),
    embedding: v.array(v.float64()),
    provenanceStatus: v.string(),
    confidence: v.number(),
    createdBy: v.string(),
    runtimeName: v.optional(v.union(v.string(), v.null())),
    runtimeVersion: v.optional(v.union(v.string(), v.null())),
    provider: v.optional(v.union(v.string(), v.null())),
    model: v.optional(v.union(v.string(), v.null())),
    taskId: v.optional(v.union(v.string(), v.null())),
    flowId: v.optional(v.union(v.string(), v.null())),
    canUseAsInstruction: v.boolean(),
    requiresUserConfirmation: v.boolean(),
    reviewStatus: v.string(),
    lastConfirmedAt: v.optional(v.union(v.string(), v.null())),
    staleAfter: v.optional(v.union(v.string(), v.null())),
    idempotencyKey: v.string(),
    contentHash: v.string(),
    metadata: metadataValidator,
    sourceRefs: v.array(sourceRefValidator),
    artifacts: v.array(artifactValidator),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("agentMemories").withIndex("by_idempotency", (q) => q.eq("idempotencyKey", args.idempotencyKey)).unique();
    if (existing) return existing;
    const timestamp = now();
    const id = await ctx.db.insert("agentMemories", {
      thoughtId: args.thoughtId ?? null,
      workspaceId: args.workspaceId,
      projectId: args.projectId ?? null,
      channelKind: args.channelKind ?? null,
      channelId: args.channelId ?? null,
      channelThreadId: args.channelThreadId ?? null,
      visibility: args.visibility,
      memoryType: args.memoryType,
      summary: args.summary,
      content: args.content,
      embedding: args.embedding,
      lifecycleStatus: "active",
      provenanceStatus: args.provenanceStatus,
      confidence: args.confidence,
      createdBy: args.createdBy,
      runtimeName: args.runtimeName ?? null,
      runtimeVersion: args.runtimeVersion ?? null,
      provider: args.provider ?? null,
      model: args.model ?? null,
      taskId: args.taskId ?? null,
      flowId: args.flowId ?? null,
      canUseAsInstruction: args.canUseAsInstruction,
      canUseAsEvidence: true,
      requiresUserConfirmation: args.requiresUserConfirmation,
      reviewStatus: args.reviewStatus,
      lastConfirmedAt: args.lastConfirmedAt ?? null,
      staleAfter: args.staleAfter ?? null,
      idempotencyKey: args.idempotencyKey,
      contentHash: args.contentHash,
      metadata: args.metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    for (const source of args.sourceRefs) {
      await ctx.db.insert("agentMemorySourceRefs", {
        memoryId: id,
        sourceKind: source.kind,
        uri: source.uri ?? null,
        title: source.title ?? null,
        sourceTimestamp: source.timestamp ?? null,
        createdAt: timestamp,
      });
    }
    for (const artifact of args.artifacts) {
      await ctx.db.insert("agentMemoryArtifacts", {
        memoryId: id,
        artifactKind: artifact.kind,
        uri: artifact.uri,
        description: artifact.description ?? null,
        createdAt: timestamp,
      });
    }
    const row = await ctx.db.get(id);
    if (!row) throw new Error("Inserted memory disappeared");
    return row;
  },
});

export const writeback = action({
  args: {
    schema_version: v.string(),
    workspace_id: v.string(),
    project_id: v.optional(v.union(v.string(), v.null())),
    task_id: v.optional(v.union(v.string(), v.null())),
    flow_id: v.optional(v.union(v.string(), v.null())),
    step_id: v.optional(v.union(v.string(), v.null())),
    idempotency_key: v.optional(v.union(v.string(), v.null())),
    content_hash: v.optional(v.union(v.string(), v.null())),
    channel: v.optional(channelValidator),
    runtime: v.optional(runtimeValidator),
    models_used: v.array(v.object({ provider: v.string(), model: v.string(), role: v.string() })),
    source_refs: v.array(sourceRefValidator),
    memory_payload: memoryPayloadValidator,
    provenance: v.object({
      default_status: v.string(),
      confidence: v.number(),
      requires_review: v.boolean(),
    }),
    retention: v.object({
      ttl_days: v.optional(v.union(v.number(), v.null())),
      stale_after_days: v.optional(v.union(v.number(), v.null())),
    }),
    visibility: metadataValidator,
  },
  handler: async (ctx, req): Promise<WritebackResponse> => {
    const rows = memoryRows(req.memory_payload);
    if (rows.length === 0) throw new Error("memory_payload produced no memory rows");
    const unsafe: UnsafeWritebackReason[] = rows.flatMap((row) => unsafeReasons(row.content).map((reason) => ({ reason, memory_type: row.memory_type })));
    if (unsafe.length > 0) {
      await ctx.runMutation(internal.agentMemory.insertAudit, {
        eventType: "memory_rejected",
        workspaceId: req.workspace_id,
        projectId: req.project_id ?? null,
        runtimeName: req.runtime?.name ?? "unknown",
        taskId: req.task_id ?? null,
        payload: { reason: "unsafe_writeback", unsafe },
      });
      return { error: "Unsafe write-back blocked", unsafe };
    }
    const provider = req.models_used[0]?.provider ?? null;
    const model = req.models_used[0]?.model ?? null;
    const defaultInstruction = ["user_confirmed", "imported"].includes(req.provenance.default_status) && !req.provenance.requires_review;
    const created: Doc<"agentMemories">[] = [];
    for (const [index, row] of rows.entries()) {
      const contentHash = await sha256Hex(`${row.memory_type}:${row.content}`);
      const baseKey = req.idempotency_key || `${req.workspace_id}:${req.runtime?.name ?? "unknown"}:${req.task_id || "taskless"}:${req.step_id || "step"}:${contentHash}`;
      const embedding = await getEmbedding(row.content);
      const memory: Doc<"agentMemories"> = await ctx.runMutation(internal.agentMemory.insertMemory, {
        thoughtId: null,
        workspaceId: req.workspace_id,
        projectId: req.project_id ?? null,
        channelKind: req.channel?.kind ?? null,
        channelId: req.channel?.id ?? null,
        channelThreadId: req.channel?.thread_id ?? null,
        visibility: req.project_id ? "project" : "personal",
        memoryType: row.memory_type,
        summary: row.content.replace(/\s+/g, " ").slice(0, 140),
        content: row.content,
        embedding,
        provenanceStatus: req.provenance.default_status,
        confidence: req.provenance.confidence,
        createdBy: req.provenance.default_status === "imported" ? "import" : "agent",
        runtimeName: req.runtime?.name ?? "unknown",
        runtimeVersion: req.runtime?.version ?? null,
        provider,
        model,
        taskId: req.task_id ?? null,
        flowId: req.flow_id ?? null,
        canUseAsInstruction: defaultInstruction,
        requiresUserConfirmation: !defaultInstruction,
        reviewStatus: defaultInstruction ? "confirmed" : "pending",
        lastConfirmedAt: defaultInstruction ? now() : null,
        staleAfter: staleAfter(req.retention.stale_after_days),
        idempotencyKey: `${baseKey}:${index}`,
        contentHash,
        metadata: {
          source_refs: req.source_refs,
          models_used: req.models_used,
          retention: req.retention,
          writeback_schema_version: req.schema_version,
        },
        sourceRefs: req.source_refs,
        artifacts: row.memory_type === "artifact_reference" ? req.memory_payload.artifacts : [],
      });
      await ctx.runMutation(internal.agentMemory.insertAudit, {
        eventType: "memory_written",
        workspaceId: req.workspace_id,
        projectId: req.project_id ?? null,
        memoryId: memory._id,
        runtimeName: req.runtime?.name ?? "unknown",
        taskId: req.task_id ?? null,
        actorKind: "agent",
        payload: { provenance_status: req.provenance.default_status, review_status: memory.reviewStatus },
      });
      created.push(memory);
    }
    return { schema_version: writebackResponseSchema(req.schema_version), memories: created.map(responseMemory) };
  },
});

export const memories = query({
  args: {
    workspace_id: v.string(),
    project_id: v.optional(v.string()),
    review_status: v.optional(v.string()),
    lifecycle_status: v.optional(v.string()),
    runtime_name: v.optional(v.string()),
    memory_type: v.optional(v.string()),
    task_id_prefix: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 50)));
    const rows = (await ctx.db.query("agentMemories").withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspace_id)).collect())
      .filter((row) => !args.project_id || row.projectId === args.project_id)
      .filter((row) => !args.review_status || row.reviewStatus === args.review_status)
      .filter((row) => !args.lifecycle_status || row.lifecycleStatus === args.lifecycle_status)
      .filter((row) => !args.runtime_name || row.runtimeName === args.runtime_name)
      .filter((row) => !args.memory_type || row.memoryType === args.memory_type)
      .filter((row) => !args.task_id_prefix || (row.taskId ?? "").startsWith(args.task_id_prefix))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return { memories: rows.map(responseMemory), count: rows.length };
  },
});

export const reviewQueue = query({
  args: { workspace_id: v.string(), project_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = (await ctx.db.query("agentMemories").withIndex("by_workspace_review", (q) => q.eq("workspaceId", args.workspace_id).eq("reviewStatus", "pending")).collect())
      .filter((row) => !args.project_id || row.projectId === args.project_id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { memories: rows.map(responseMemory) };
  },
});

export const memory = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const memoryRow = await ctx.db.get(memoryIdFromString(args.id));
    if (!memoryRow) return null;
    const sourceRefs = await ctx.db.query("agentMemorySourceRefs").withIndex("by_memory", (q) => q.eq("memoryId", memoryRow._id)).collect();
    const artifacts = await ctx.db.query("agentMemoryArtifacts").withIndex("by_memory", (q) => q.eq("memoryId", memoryRow._id)).collect();
    return { memory: { ...memoryRow, agent_memory_source_refs: sourceRefs, agent_memory_artifacts: artifacts } };
  },
});

export const reviewMemory = mutation({
  args: {
    id: v.string(),
    action: v.string(),
    actor_id: v.optional(v.union(v.string(), v.null())),
    actor_label: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    content: v.optional(v.string()),
    summary: v.optional(v.string()),
    visibility: v.optional(v.string()),
    related_memory_id: v.optional(v.string()),
  },
  handler: async (ctx, req) => {
    const id = memoryIdFromString(req.id);
    const before = await ctx.db.get(id);
    if (!before) throw new Error("Memory not found");
    const updates: {
      reviewStatus?: string;
      provenanceStatus?: string;
      canUseAsInstruction?: boolean;
      canUseAsEvidence?: boolean;
      requiresUserConfirmation?: boolean;
      lastConfirmedAt?: string;
      lifecycleStatus?: string;
      visibility?: string;
      content?: string;
      summary?: string;
      updatedAt: string;
    } = { updatedAt: now() };
    if (req.action === "confirm") {
      updates.reviewStatus = "confirmed";
      updates.provenanceStatus = "user_confirmed";
      updates.canUseAsInstruction = true;
      updates.requiresUserConfirmation = false;
      updates.lastConfirmedAt = now();
    } else if (req.action === "evidence_only") {
      updates.reviewStatus = "evidence_only";
      updates.canUseAsInstruction = false;
      updates.canUseAsEvidence = true;
      updates.requiresUserConfirmation = false;
    } else if (req.action === "reject") {
      updates.reviewStatus = "rejected";
      updates.lifecycleStatus = "rejected";
      updates.canUseAsInstruction = false;
      updates.canUseAsEvidence = false;
    } else if (req.action === "mark_stale") {
      updates.reviewStatus = "stale";
      updates.lifecycleStatus = "stale";
      updates.canUseAsInstruction = false;
    } else if (req.action === "dispute") {
      updates.lifecycleStatus = "disputed";
      updates.provenanceStatus = "disputed";
      updates.canUseAsInstruction = false;
    } else if (req.action === "restrict_scope") {
      updates.reviewStatus = "restricted";
      updates.visibility = req.visibility || "personal";
    } else if (req.action === "edit") {
      if (req.content) updates.content = req.content;
      if (req.summary) updates.summary = req.summary;
    }
    await ctx.db.patch(id, updates);
    const after = await ctx.db.get(id);
    if (!after) throw new Error("Memory not found after review");
    await ctx.db.insert("agentMemoryReviewActions", {
      memoryId: id,
      action: req.action,
      actorId: req.actor_id ?? null,
      actorLabel: req.actor_label ?? null,
      notes: req.notes ?? null,
      before,
      after,
      createdAt: now(),
    });
    if (req.related_memory_id && ["merge", "supersede"].includes(req.action)) {
      await ctx.db.insert("agentMemoryRelations", {
        fromMemoryId: id,
        toMemoryId: memoryIdFromString(req.related_memory_id),
        relation: req.action === "merge" ? "merged_into" : "supersedes",
        confidence: 1,
        createdAt: now(),
      });
    }
    await ctx.db.insert("agentMemoryAuditEvents", {
      eventType: req.action === "confirm" ? "memory_confirmed" : req.action === "reject" ? "memory_rejected" : "memory_edited",
      workspaceId: before.workspaceId,
      projectId: before.projectId ?? null,
      memoryId: id,
      traceId: null,
      actorKind: "user",
      actorLabel: req.actor_label ?? null,
      runtimeName: null,
      taskId: before.taskId ?? null,
      payload: { action: req.action },
      createdAt: now(),
    });
    return { memory: after };
  },
});

export const recallTrace = query({
  args: { request_id: v.string() },
  handler: async (ctx, args) => {
    const trace = await ctx.db.query("agentMemoryRecallTraces").withIndex("by_request", (q) => q.eq("requestId", args.request_id)).unique();
    if (!trace) return null;
    const items = await ctx.db.query("agentMemoryRecallItems").withIndex("by_trace_rank", (q) => q.eq("traceId", trace._id)).collect();
    const enriched = [];
    for (const item of items.sort((a, b) => a.rank - b.rank)) {
      enriched.push({ ...item, agent_memories: await ctx.db.get(item.memoryId) });
    }
    return { trace, items: enriched };
  },
});

export const reportUsage = mutation({
  args: {
    request_id: v.string(),
    used_memory_ids: v.array(v.string()),
    ignored: v.array(v.object({ memory_id: v.string(), reason: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const trace = await ctx.db.query("agentMemoryRecallTraces").withIndex("by_request", (q) => q.eq("requestId", args.request_id)).unique();
    if (!trace) throw new Error("Recall trace not found");
    const items = await ctx.db.query("agentMemoryRecallItems").withIndex("by_trace_rank", (q) => q.eq("traceId", trace._id)).collect();
    for (const item of items) {
      if (args.used_memory_ids.includes(String(item.memoryId))) {
        await ctx.db.patch(item._id, { used: true });
      }
      const ignored = args.ignored.find((entry) => entry.memory_id === String(item.memoryId));
      if (ignored) {
        await ctx.db.patch(item._id, { used: false, ignoredReason: ignored.reason ?? null });
      }
    }
    return { ok: true };
  },
});
