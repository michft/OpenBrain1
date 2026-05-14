import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const metadata = v.record(v.string(), v.any());

export default defineSchema({
  thoughts: defineTable({
    content: v.string(),
    metadata,
    embedding: v.array(v.float64()),
    type: v.string(),
    sourceType: v.string(),
    importance: v.number(),
    qualityScore: v.number(),
    sensitivityTier: v.string(),
    status: v.optional(v.union(v.string(), v.null())),
    statusUpdatedAt: v.optional(v.union(v.string(), v.null())),
    contentFingerprint: v.string(),
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_type", ["type"])
    .index("by_sourceType", ["sourceType"])
    .index("by_status", ["status"])
    .index("by_contentFingerprint", ["contentFingerprint"])
    .searchIndex("by_content", {
      searchField: "content",
      filterFields: ["type", "sourceType", "sensitivityTier", "status"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["type", "sourceType", "sensitivityTier", "status"],
    }),

  reflections: defineTable({
    thoughtId: v.id("thoughts"),
    triggerContext: v.string(),
    options: v.array(v.any()),
    factors: v.array(v.any()),
    conclusion: v.string(),
    confidence: v.number(),
    reflectionType: v.string(),
    metadata,
    createdAt: v.string(),
  }).index("by_thought", ["thoughtId"]),

  agentMemories: defineTable({
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
    lifecycleStatus: v.string(),
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
    canUseAsEvidence: v.boolean(),
    requiresUserConfirmation: v.boolean(),
    reviewStatus: v.string(),
    lastConfirmedAt: v.optional(v.union(v.string(), v.null())),
    staleAfter: v.optional(v.union(v.string(), v.null())),
    idempotencyKey: v.string(),
    contentHash: v.string(),
    metadata,
    createdAt: v.string(),
    updatedAt: v.string(),
  })
    .index("by_workspace_created", ["workspaceId", "createdAt"])
    .index("by_workspace_review", ["workspaceId", "reviewStatus"])
    .index("by_project", ["workspaceId", "projectId"])
    .index("by_idempotency", ["idempotencyKey"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["workspaceId", "projectId", "reviewStatus", "lifecycleStatus"],
    }),

  agentMemorySourceRefs: defineTable({
    memoryId: v.id("agentMemories"),
    sourceKind: v.string(),
    uri: v.optional(v.union(v.string(), v.null())),
    title: v.optional(v.union(v.string(), v.null())),
    sourceTimestamp: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
  }).index("by_memory", ["memoryId"]),

  agentMemoryArtifacts: defineTable({
    memoryId: v.id("agentMemories"),
    artifactKind: v.string(),
    uri: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
  }).index("by_memory", ["memoryId"]),

  agentMemoryReviewActions: defineTable({
    memoryId: v.id("agentMemories"),
    action: v.string(),
    actorId: v.optional(v.union(v.string(), v.null())),
    actorLabel: v.optional(v.union(v.string(), v.null())),
    notes: v.optional(v.union(v.string(), v.null())),
    before: metadata,
    after: metadata,
    createdAt: v.string(),
  }).index("by_memory", ["memoryId"]),

  agentMemoryRelations: defineTable({
    fromMemoryId: v.id("agentMemories"),
    toMemoryId: v.id("agentMemories"),
    relation: v.string(),
    confidence: v.number(),
    createdAt: v.string(),
  }).index("by_from", ["fromMemoryId"]),

  agentMemoryRecallTraces: defineTable({
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
    requestPayload: metadata,
    responsePolicy: metadata,
    createdAt: v.string(),
  })
    .index("by_request", ["requestId"])
    .index("by_workspace_created", ["workspaceId", "createdAt"]),

  agentMemoryRecallItems: defineTable({
    traceId: v.id("agentMemoryRecallTraces"),
    memoryId: v.id("agentMemories"),
    rank: v.number(),
    similarity: v.number(),
    rankingScore: v.number(),
    usePolicySnapshot: metadata,
    used: v.optional(v.union(v.boolean(), v.null())),
    ignoredReason: v.optional(v.union(v.string(), v.null())),
    createdAt: v.string(),
  }).index("by_trace_rank", ["traceId", "rank"]),

  agentMemoryAuditEvents: defineTable({
    eventType: v.string(),
    workspaceId: v.optional(v.union(v.string(), v.null())),
    projectId: v.optional(v.union(v.string(), v.null())),
    memoryId: v.optional(v.union(v.id("agentMemories"), v.null())),
    traceId: v.optional(v.union(v.id("agentMemoryRecallTraces"), v.null())),
    actorKind: v.string(),
    actorLabel: v.optional(v.union(v.string(), v.null())),
    runtimeName: v.optional(v.union(v.string(), v.null())),
    taskId: v.optional(v.union(v.string(), v.null())),
    payload: metadata,
    createdAt: v.string(),
  }).index("by_workspace_created", ["workspaceId", "createdAt"]),
});
