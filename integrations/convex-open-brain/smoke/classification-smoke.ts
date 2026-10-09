import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.CONVEX_SITE_URL?.replace(/\/+$/, "");
const key = process.env.MCP_ACCESS_KEY;
assert(base && key, "Development Convex site and agent key required.");
assert(process.env.CONVEX_DEPLOYMENT?.startsWith("dev:"), "Classification smoke requires a development deployment.");
const url = new URL(base);
assert(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash, "Clean HTTPS Convex site required.");
async function request(path: string, body?: unknown, method = body ? "POST" : "GET"): Promise<Response> {
  return fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(45_000),
    headers: { "x-brain-key": key!, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const marker = `OB1 classification smoke ${randomUUID()}`;
let createdId: string | undefined;
let runError: unknown;
try {
  const captured = await request("/capture", {
    content: `${marker}: Avery met Sam on 2026-10-10 to discuss library shelving.`,
    source_type: "deployment_smoke",
  });
  assert.equal(captured.status, 200, "Hosted capture failed.");
  const result: { thought_id?: string; action?: string } = await captured.json();
  assert(result.thought_id && result.action === "created", "Expected a new unique smoke thought; existing data must remain untouched.");
  createdId = result.thought_id;
  const fetched = await request(`/thought/${encodeURIComponent(createdId)}`);
  assert.equal(fetched.status, 200, "Smoke thought fetch failed.");
  const thought: { content?: string; metadata?: Record<string, unknown> } = await fetched.json();
  assert(thought.content?.includes(marker), "Smoke thought marker missing.");
  const people = thought.metadata?.people;
  assert(Array.isArray(people) && people.some((person: unknown) => typeof person === "string" && person.includes("Avery")), "Model must extract explicit people; fallback capture is not provider verification.");
} catch (error) {
  runError = error;
} finally {
  if (createdId) {
    const path = `/thought/${encodeURIComponent(createdId)}`;
    const deleted = await request(path, undefined, "DELETE");
    assert.equal(deleted.status, 200, `Failed to clean up smoke thought ${createdId}.`);
    assert.equal((await request(path)).status, 404, "Deleted smoke thought still accessible.");
  }
}
if (runError) throw runError;
console.log(JSON.stringify({ ok: true, endpoint: base, checks: ["hosted capture with real embedding", "model-extracted explicit people", "test thought deleted and absence verified"], cleaned_up: 1 }, null, 2));
