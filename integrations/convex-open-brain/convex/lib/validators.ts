import { v } from "convex/values";
import type { Infer } from "convex/values";

const metadataScalar = v.union(v.string(), v.number(), v.boolean(), v.null());
const metadataScalarArray = v.array(metadataScalar);
const metadataFlatRecord = v.record(v.string(), v.union(metadataScalar, metadataScalarArray));

export const runtimeValidator = v.object({
  name: v.string(),
  version: v.optional(v.union(v.string(), v.null())),
});

export const channelValidator = v.object({
  kind: v.optional(v.union(v.string(), v.null())),
  id: v.optional(v.union(v.string(), v.null())),
  thread_id: v.optional(v.union(v.string(), v.null())),
});

export const sourceRefValidator = v.object({
  kind: v.string(),
  uri: v.optional(v.union(v.string(), v.null())),
  title: v.optional(v.union(v.string(), v.null())),
  timestamp: v.optional(v.union(v.string(), v.null())),
});

export const artifactValidator = v.object({
  kind: v.string(),
  uri: v.string(),
  description: v.optional(v.union(v.string(), v.null())),
});

export const modelUsedValidator = v.object({
  provider: v.string(),
  model: v.string(),
  role: v.string(),
});

export const retentionValidator = v.object({
  ttl_days: v.optional(v.union(v.number(), v.null())),
  stale_after_days: v.optional(v.union(v.number(), v.null())),
});

export const metadataValueValidator = v.union(
  metadataScalar,
  metadataScalarArray,
  metadataFlatRecord,
  v.array(metadataFlatRecord),
  v.array(sourceRefValidator),
  v.array(modelUsedValidator),
  retentionValidator,
);

export const metadataValidator = v.record(v.string(), metadataValueValidator);
export type Metadata = Infer<typeof metadataValidator>;

export const reflectionOptionValidator = v.object({
  label: v.string(),
});

export const reflectionFactorValidator = v.object({
  label: v.string(),
  weight: v.number(),
});
