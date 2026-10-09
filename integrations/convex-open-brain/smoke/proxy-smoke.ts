import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const values = parseEnv(await readFile(process.env.OB1_STANDALONE_ENV || resolve(homedir(), ".config/ob1/standalone.env"), "utf8"));
const address = process.env.OB1_PROXY_HTTPS_URL || values.OB1_PROXY_LOCAL_URL;
assert(address, "Standalone proxy URL required.");
const base = new URL(address);
assert((base.protocol === "https:" || base.protocol === "http:" && base.hostname === "127.0.0.1") && !base.username && !base.password && !base.search && !base.hash, "Clean HTTPS or local loopback URL required.");
const key = values.OB1_PROXY_API_KEY;
assert(key && values.OB1_PROXY_MODEL, "Standalone proxy credentials/model required.");
const endpoint = base.href.replace(/\/+$/, "");
async function request(path: string, authenticated: boolean, body?: unknown): Promise<Response> {
  return fetch(`${endpoint}${path}`, {
    method: body ? "POST" : "GET", signal: AbortSignal.timeout(45_000),
    headers: { ...(authenticated ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
assert.equal((await request("/models", false)).status, 401, "Unauthenticated model listing must be rejected.");
const wrongKey = await fetch(`${endpoint}/models`, { headers: { Authorization: "Bearer ob1-invalid-probe" }, signal: AbortSignal.timeout(10_000) });
assert.equal(wrongKey.status, 401, "Invalid proxy key must be rejected.");
const listed = await request("/models", true);
assert.equal(listed.status, 200, "Authenticated model listing failed.");
const catalog: { data?: Array<{ id?: string }> } = await listed.json();
assert(catalog.data?.some((model) => model.id === values.OB1_PROXY_MODEL), "Installed classification alias not advertised.");
for (const path of ["/v0/management/config", "/v1/management/config"]) {
  const response: Response = await fetch(new URL(path, base), { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 404, "Management must remain unavailable.");
}
const classified = await request("/chat/completions", true, {
  model: values.OB1_PROXY_MODEL, response_format: { type: "json_object" },
  messages: [
    { role: "system", content: 'Extract explicit metadata. Return JSON with people, topics, action_items, dates_mentioned arrays and type. Type must be observation, task, idea, reference, person_note, decision, lesson, meeting, or journal.' },
    { role: "user", content: "Avery met Sam on 2026-10-10 to discuss library shelving." },
  ],
});
assert.equal(classified.status, 200, "Actual proxy-backed classification request failed.");
const completion: { choices?: Array<{ message?: { content?: string } }> } = await classified.json();
assert(completion.choices?.[0]?.message?.content, "Classification content missing.");
const metadata: Record<string, unknown> = JSON.parse(completion.choices[0].message.content);
for (const name of ["people", "topics", "action_items", "dates_mentioned"]) assert(Array.isArray(metadata[name]), `Classification ${name} must be an array.`);
assert(Array.isArray(metadata.people) && metadata.people.some((person: unknown) => typeof person === "string" && person.includes("Avery")), "Real upstream must extract explicit person, unlike local fallback.");
assert(["observation", "task", "idea", "reference", "person_note", "decision", "lesson", "meeting", "journal"].includes(String(metadata.type)), "Invalid classification type.");
console.log(JSON.stringify({ ok: true, endpoint, model: values.OB1_PROXY_MODEL, checks: ["missing/invalid key rejected", "classification alias advertised", "management disabled", "real proxy-backed JSON classification"] }, null, 2));
