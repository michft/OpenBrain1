const baseUrl = (process.env.OB1_CONVEX_URL || process.env.NEXT_PUBLIC_API_URL || "").replace(/\/$/, "");
const accessKey = process.env.OB1_CONVEX_KEY || process.env.MCP_ACCESS_KEY || "";

if (!baseUrl) fail("Set OB1_CONVEX_URL or NEXT_PUBLIC_API_URL.");
if (!accessKey) fail("Set OB1_CONVEX_KEY or MCP_ACCESS_KEY.");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "x-brain-key": accessKey,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${init.method || "GET"} ${path} failed: ${response.status} ${text}`);
  }
  return data;
}

const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const content = `OB1 Convex smoke ${runId}: verify capture, search, dashboard REST, and MCP compatibility.`;

const health = await request("/health");
const capture = await request("/capture", {
  method: "POST",
  body: JSON.stringify({ content, source_type: "convex_smoke", type: "observation" }),
});
const thought = await request(`/thought/${capture.thought_id}`);
const search = await request("/search", {
  method: "POST",
  body: JSON.stringify({ query: `Convex smoke ${runId}`, mode: "semantic", limit: 5 }),
});
const stats = await request("/stats");
const mcpInit = await request("/mcp", {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
const mcpTools = await request("/mcp", {
  method: "POST",
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
});

console.log(JSON.stringify({
  ok: true,
  backend: "convex",
  health,
  captured: capture.thought_id,
  fetched_type: thought.type,
  search_count: search.count,
  total_thoughts: stats.total_thoughts,
  mcp_server: mcpInit.result?.serverInfo?.name,
  mcp_tool_count: mcpTools.result?.tools?.length,
}, null, 2));
