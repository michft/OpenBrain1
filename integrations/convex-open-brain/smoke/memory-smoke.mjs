#!/usr/bin/env node

import assert from "node:assert/strict";

const baseUrl = (process.env.OB1_CONVEX_URL || process.env.CONVEX_SITE_URL || process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const accessKey = process.env.OB1_CONVEX_KEY || process.env.MCP_ACCESS_KEY || "";
const adminKey = process.env.OB1_CONVEX_ADMIN_KEY || process.env.MCP_ADMIN_KEY || "";
const workspaceId = process.env.OB1_AGENT_MEMORY_WORKSPACE_ID || "ob1-staging";
const projectId = process.env.OB1_AGENT_MEMORY_PROJECT_ID || "";

assert(baseUrl, "Set OB1_CONVEX_URL, CONVEX_SITE_URL, or NEXT_PUBLIC_API_URL.");
assert(accessKey, "Set OB1_CONVEX_KEY or MCP_ACCESS_KEY.");
assert(adminKey, "Set OB1_CONVEX_ADMIN_KEY or MCP_ADMIN_KEY.");
assert(adminKey !== accessKey, "Agent and admin keys must be different.");
assert(!new URL(baseUrl).search && !new URL(baseUrl).username && !new URL(baseUrl).password, "Pass a base URL without credentials or a query string.");

async function request(path, init = {}, key = accessKey, expectedStatus = 200, expectedError = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-brain-key": key } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${init.method || "GET"} ${path} returned ${response.status}; expected ${expectedStatus}`);
  }
  if (expectedError) assert(text.includes(expectedError), `${init.method || "GET"} ${path} did not include the expected error`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${init.method || "GET"} ${path} returned non-JSON data`);
  }
}

function memoryQuery(cursor, limit = 1) {
  const params = new URLSearchParams({ workspace_id: workspaceId, limit: String(limit) });
  if (projectId) params.set("project_id", projectId);
  if (cursor) params.set("cursor", cursor);
  return params;
}

function assertPage(body, label, limit) {
  assert(body && typeof body === "object", `${label} did not return an object`);
  assert(Array.isArray(body.memories), `${label} did not return memories`);
  assert(typeof body.count === "number", `${label} did not return count`);
  assert.equal(body.count, body.memories.length, `${label} count did not match returned memories`);
  assert(body.count <= limit, `${label} exceeded the requested limit`);
  assert(typeof body.is_done === "boolean", `${label} did not return is_done`);
  assert(typeof body.scan_limited === "boolean", `${label} did not return scan_limited`);
  assert(body.continue_cursor === null || typeof body.continue_cursor === "string", `${label} returned an invalid cursor`);
  assert(body.continue_cursor !== "", `${label} returned an empty cursor`);
  assert(body.memories.every((memory) => typeof memory?.memory_id === "string" && memory.memory_id), `${label} returned a malformed memory ID`);
}

async function main() {
  const checks = [];

  const firstPage = await request(`/agent-memory-api/memories?${memoryQuery(null, 1)}`);
  assertPage(firstPage, "memory pagination", 1);
  let memoryResumeCount = 0;
  if (firstPage.is_done) assert.equal(firstPage.continue_cursor, null);
  else {
    assert(firstPage.continue_cursor, "memory pagination did not provide a resume cursor");
    const resumed = await request(`/agent-memory-api/memories?${memoryQuery(firstPage.continue_cursor, 1)}`);
    assertPage(resumed, "memory pagination continuation", 1);
    assert(!resumed.memories.some((memory) => firstPage.memories.some((first) => memory.memory_id === first.memory_id)), "memory pagination repeated a row");
    memoryResumeCount = resumed.count;
  }
  checks.push({ name: "memory pagination read", first_count: firstPage.count, resumed_count: memoryResumeCount, resumed: !firstPage.is_done });

  const reviewPage = await request(`/agent-memory-api/memories/review?${memoryQuery(null, 1)}`);
  assertPage(reviewPage, "review pagination", 1);
  let reviewResumeCount = 0;
  if (reviewPage.is_done) assert.equal(reviewPage.continue_cursor, null);
  else {
    assert(reviewPage.continue_cursor, "review pagination did not provide a resume cursor");
    const resumed = await request(`/agent-memory-api/memories/review?${memoryQuery(reviewPage.continue_cursor, 1)}`);
    assertPage(resumed, "review pagination continuation", 1);
    assert(!resumed.memories.some((memory) => reviewPage.memories.some((first) => memory.memory_id === first.memory_id)), "review pagination repeated a row");
    reviewResumeCount = resumed.count;
  }
  checks.push({ name: "review queue pagination read", first_count: reviewPage.count, resumed_count: reviewResumeCount, resumed: !reviewPage.is_done });

  for (const limit of ["0", "201"]) {
    await request(`/agent-memory-api/memories?${memoryQuery(null, Number(limit))}`, {}, accessKey, 400);
  }
  checks.push("invalid pagination limits rejected");

  for (const id of ["bad-id", "not-a-convex-memory-id"]) {
    await request(`/agent-memory-api/memories/${encodeURIComponent(id)}`, {}, accessKey, 404);
  }
  checks.push("malformed memory IDs return 404");

  const candidateId = firstPage.memories[0]?.memory_id || "bad-id";
  const candidatePath = `/agent-memory-api/memories/${encodeURIComponent(candidateId)}`;
  const beforeCandidate = candidateId === "bad-id" ? null : await request(candidatePath);

  await request(`/agent-memory-api/memories/${encodeURIComponent(candidateId)}/review`, {
    method: "PATCH",
    body: JSON.stringify({ action: "confirm" }),
  }, accessKey, 403);
  checks.push("agent review rejected");

  await request(`/agent-memory-api/memories/${encodeURIComponent(candidateId)}/review`, {
    method: "PATCH",
    body: JSON.stringify({ action: "merge" }),
  }, adminKey, 500, "Unsupported review action");
  checks.push("admin unsupported review action rejected");

  const afterCandidate = beforeCandidate ? await request(candidatePath) : null;
  const stateComparable = Boolean(beforeCandidate && afterCandidate);
  if (stateComparable) assert(JSON.stringify(afterCandidate) === JSON.stringify(beforeCandidate), "review rejection changed observable memory state");
  checks.push({
    name: "review rejections preserve observable state",
    verified: stateComparable,
    reason: stateComparable ? "candidate memory unchanged" : "no candidate memory returned on the first page",
  });

  console.log(JSON.stringify({
    ok: true,
    endpoint: `${baseUrl}/agent-memory-api`,
    workspace_configured: Boolean(process.env.OB1_AGENT_MEMORY_WORKSPACE_ID),
    project_configured: Boolean(projectId),
    checks,
    audit_state_observable: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Memory smoke failed");
  process.exitCode = 1;
});
