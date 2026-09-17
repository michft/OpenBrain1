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

function metadataKey(key: string): boolean {
  return key.length > 0 && key.length <= 1024 && !/^[$_]/.test(key) && /^[\x20-\x7e]+$/.test(key);
}

function metadataScalarValue(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function metadataScalarList(value: unknown): value is Array<string | number | boolean | null> {
  return Array.isArray(value) && value.every(metadataScalarValue);
}

function metadataFlatObject(value: unknown): value is Record<string, string | number | boolean | null | Array<string | number | boolean | null>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => metadataKey(key) && (metadataScalarValue(item) || metadataScalarList(item)));
}

/** Drop model-generated values that the stored metadata schema cannot accept. */
export function coerceMetadata(value: unknown): Metadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, Metadata[string]] => {
    const [key, item] = entry;
    return metadataKey(key) && (metadataScalarValue(item) || metadataScalarList(item)
      || metadataFlatObject(item) || (Array.isArray(item) && item.every(metadataFlatObject)));
  }));
}

export const reflectionOptionValidator = v.object({
  label: v.string(),
});

export const reflectionFactorValidator = v.object({
  label: v.string(),
  weight: v.number(),
});
