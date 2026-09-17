const OPENROUTER_BASE = process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1";
const EMBEDDING_MODEL = process.env.OPEN_BRAIN_EMBEDDING_MODEL || "openai/text-embedding-3-small";
const CLASSIFICATION_MODEL = process.env.OPEN_BRAIN_CLASSIFICATION_MODEL || "openai/gpt-4o-mini";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

type EmbeddingResponse = {
  data?: Array<{ embedding?: number[] }>;
};

export async function getEmbedding(text: string): Promise<number[]> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not configured");
  const response = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter embeddings failed: ${response.status} ${await response.text()}`);
  const data = (await response.json()) as EmbeddingResponse;
  const embedding = data.data?.[0]?.embedding;
  if (!embedding || embedding.length !== 1536) {
    throw new Error(`Expected a 1536-dimension embedding from ${EMBEDDING_MODEL}`);
  }
  return embedding;
}

export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return fallbackMetadata(text);
  const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLASSIFICATION_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Extract metadata from this Open Brain thought. Return JSON with "people", "topics", "action_items", "dates_mentioned", and "type". Type must be one of observation, task, idea, reference, person_note, decision, lesson, meeting, journal. Only extract what is explicit.',
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!response.ok) return fallbackMetadata(text);
  const data = (await response.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) return fallbackMetadata(text);
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed;
  } catch {
    return fallbackMetadata(text);
  }
}

export function fallbackMetadata(text: string): Record<string, unknown> {
  const lower = text.toLowerCase();
  const type = /\b(todo|next step|ship|implement|fix|review|publish)\b/.test(lower)
    ? "task"
    : /\b(decided|decision|must|should)\b/.test(lower)
      ? "decision"
      : /\b(recipe|docs|reference|guide|url|http)\b/.test(lower)
        ? "reference"
        : "observation";
  const topics = [
    lower.includes("openclaw") ? "OpenClaw" : null,
    lower.includes("agent memory") ? "agent memory" : null,
    lower.includes("dashboard") ? "dashboard" : null,
    lower.includes("convex") ? "Convex" : null,
    lower.includes("nate") ? "Nate Jones" : null,
  ].filter((topic): topic is string => Boolean(topic));
  return { type, topics: topics.length ? topics : ["open brain"], people: [], action_items: [], dates_mentioned: [] };
}
