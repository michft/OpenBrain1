import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractMetadata, fallbackMetadata, getEmbedding } from "./openrouter";

beforeEach(() => vi.stubEnv("OPENROUTER_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("bounds both requests to 20 seconds; metadata timeout falls back while embedding failure stays visible", async () => {
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
])("falls back on metadata HTTP and parsing failures", async (response) => {
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
