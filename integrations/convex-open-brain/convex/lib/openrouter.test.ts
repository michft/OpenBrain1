import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractMetadata, fallbackMetadata, getEmbedding } from "./openrouter";

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_BASE_URL", "");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("bounds both requests to 20 seconds; metadata timeout falls back while embedding failure stays visible", async () => {
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_BASE_URL", "https://proxy.example/v1");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_API_KEY", "proxy-key");
  const signal = AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.signal).toBe(signal);
    throw signal.reason;
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await extractMetadata("Review the deployment")).toEqual(fallbackMetadata("Review the deployment"));
  await expect(getEmbedding("Review the deployment")).rejects.toThrow("Timed out");
  expect(timeout.mock.calls).toEqual([[20_000], [20_000]]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([
  new Response("unavailable", { status: 503 }),
  new Response("invalid JSON"),
  Response.json({ choices: [{ message: { content: "invalid JSON" } }] }),
  Response.json({ choices: [] }),
])("falls back on metadata HTTP and parsing failures", async (response) => {
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_BASE_URL", "https://proxy.example/v1");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_API_KEY", "proxy-key");
  vi.stubGlobal("fetch", vi.fn(async () => response));
  expect(await extractMetadata("Convex reference")).toEqual(fallbackMetadata("Convex reference"));
});

it("preserves successful metadata and embedding responses", async () => {
  const embedding = [1, ...Array<number>(1535).fill(0)];
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"type":"idea"}' } }] }))
    .mockResolvedValueOnce(Response.json({ data: [{ embedding }] })));
  expect(await extractMetadata("A new idea")).toEqual({ type: "idea" });
  expect(await getEmbedding("A new idea")).toEqual(embedding);
});

it("keeps default OpenRouter classification for existing deployments", async () => {
  const fetchMock = vi.fn(async () => Response.json({ choices: [{ message: { content: '{"type":"idea"}' } }] }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await extractMetadata("A new idea")).toEqual({ type: "idea" });
  expect(fetchMock).toHaveBeenCalledWith("https://openrouter.ai/api/v1/chat/completions", expect.objectContaining({
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    body: expect.stringContaining('"model":"openai/gpt-4o-mini"'),
  }));
});

it("routes classification to proxy with its own key and model while embeddings retain OpenRouter settings", async () => {
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_BASE_URL", "https://proxy.example/v1/");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_API_KEY", "proxy-key");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_MODEL", "proxy-classifier");
  vi.stubEnv("OPENROUTER_BASE", "https://openrouter.example/api/v1");
  vi.stubEnv("OPEN_BRAIN_EMBEDDING_MODEL", "openai/text-embedding-3-small");
  const client = await import("./openrouter");
  const embedding = [1, ...Array<number>(1535).fill(0)];
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"type":"idea"}' } }] }))
    .mockResolvedValueOnce(Response.json({ data: [{ embedding }] }));
  vi.stubGlobal("fetch", fetchMock);

  expect(await client.extractMetadata("A new idea")).toEqual({ type: "idea" });
  expect(await client.getEmbedding("A new idea")).toEqual(embedding);
  expect(fetchMock).toHaveBeenNthCalledWith(1, "https://proxy.example/v1/chat/completions", expect.objectContaining({
    headers: { Authorization: "Bearer proxy-key", "Content-Type": "application/json" },
    body: expect.stringContaining('"model":"proxy-classifier"'),
  }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, "https://openrouter.example/api/v1/embeddings", expect.objectContaining({
    headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "A new idea" }),
  }));
});

it("allows proxy classification without an OpenRouter key", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_BASE_URL", "https://proxy.example/v1");
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_API_KEY", "proxy-key");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: '{"type":"idea"}' } }] })));
  expect(await extractMetadata("A new idea")).toEqual({ type: "idea" });
  await expect(getEmbedding("A new idea")).rejects.toThrow("OPENROUTER_API_KEY is not configured");
});

it.each([
  ["https://proxy.example/v1", ""],
  ["", "proxy-key"],
  ["not a URL", "proxy-key"],
  ["http://proxy.example/v1", "proxy-key"],
  ["https://username:password@proxy.example/v1", "proxy-key"],
  ["https://proxy.example/v1?api_key=secret", "proxy-key"],
  ["https://proxy.example/v1#fragment", "proxy-key"],
])("uses local fallback without sending credentials for incomplete or invalid proxy config %s", async (base, key) => {
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_BASE_URL", base);
  vi.stubEnv("OPEN_BRAIN_CLASSIFICATION_API_KEY", key);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  expect(await extractMetadata("Convex reference")).toEqual(fallbackMetadata("Convex reference"));
  expect(fetchMock).not.toHaveBeenCalled();
});
