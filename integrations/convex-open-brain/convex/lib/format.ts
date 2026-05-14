import type { Doc, Id } from "../_generated/dataModel";

export type PublicThought = {
  id: string;
  uuid: string;
  content: string;
  type: string;
  source_type: string;
  importance: number;
  quality_score: number;
  sensitivity_tier: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  status: string | null;
  status_updated_at: string | null;
};

export type PublicMemory = {
  memory_id: string;
  summary: string;
  content: string;
  source: {
    kind: string;
    uri: string | null;
    title: string;
    timestamp: string;
  };
  provenance: {
    status: string;
    confidence: number;
    created_by: string;
    model: string | null;
    runtime: string | null;
  };
  scope: {
    workspace_id: string;
    project_id: string | null;
    channel_id: string | null;
    visibility: string;
  };
  use_policy: {
    can_use_as_instruction: boolean;
    can_use_as_evidence: boolean;
    requires_user_confirmation: boolean;
  };
  freshness: {
    created_at: string;
    last_confirmed_at: string | null;
    stale_after: string | null;
  };
  related_artifacts: unknown[];
};

export function normalizeThought(row: Doc<"thoughts">, extra: Record<string, unknown> = {}): PublicThought & Record<string, unknown> {
  return {
    id: row._id,
    uuid: row._id,
    content: row.content,
    type: row.type,
    source_type: row.sourceType,
    importance: row.importance,
    quality_score: row.qualityScore,
    sensitivity_tier: row.sensitivityTier,
    metadata: {
      ...row.metadata,
      type: row.type,
      source: row.sourceType,
      source_type: row.sourceType,
      convex_id: row._id,
    },
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    status: row.status ?? null,
    status_updated_at: row.statusUpdatedAt ?? null,
    ...extra,
  };
}

export function responseMemory(memory: Doc<"agentMemories">): PublicMemory {
  return {
    memory_id: memory._id,
    summary: memory.summary,
    content: memory.content,
    source: {
      kind: "agent_memory",
      uri: null,
      title: memory.summary,
      timestamp: memory.createdAt,
    },
    provenance: {
      status: memory.provenanceStatus,
      confidence: memory.confidence,
      created_by: memory.createdBy,
      model: memory.model ?? null,
      runtime: memory.runtimeName ?? null,
    },
    scope: {
      workspace_id: memory.workspaceId,
      project_id: memory.projectId ?? null,
      channel_id: memory.channelId ?? null,
      visibility: memory.visibility,
    },
    use_policy: {
      can_use_as_instruction: memory.canUseAsInstruction,
      can_use_as_evidence: memory.canUseAsEvidence,
      requires_user_confirmation: memory.requiresUserConfirmation,
    },
    freshness: {
      created_at: memory.createdAt,
      last_confirmed_at: memory.lastConfirmedAt ?? null,
      stale_after: memory.staleAfter ?? null,
    },
    related_artifacts: [],
  };
}

export function thoughtTitle(content: string, createdAt?: string): string {
  const firstLine = content.replace(/\s+/g, " ").trim().slice(0, 80);
  const datePrefix = createdAt ? new Date(createdAt).toLocaleDateString() : "Open Brain";
  return firstLine ? `${datePrefix} - ${firstLine}` : `${datePrefix} thought`;
}

export function thoughtUrl(id: string): string {
  const base = process.env.OPEN_BRAIN_CITATION_BASE_URL || "https://openbrain.local/thoughts";
  return `${base.replace(/\/$/, "")}/${id}`;
}

export function idFromString(value: string): Id<"thoughts"> {
  return value as Id<"thoughts">;
}

export function memoryIdFromString(value: string): Id<"agentMemories"> {
  return value as Id<"agentMemories">;
}

export function compactFingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}

export function tokenSimilarity(a: string, b: string): number {
  const aTokens = new Set(a.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const bTokens = new Set(b.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
  const union = new Set([...aTokens, ...bTokens]).size;
  return intersection / union;
}
