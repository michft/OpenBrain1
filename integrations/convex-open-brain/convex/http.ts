import { httpRouter } from "convex/server";
import type { FunctionArgs } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { thoughtTitle, thoughtUrl } from "./lib/format";
import type { PublicThought } from "./lib/format";

const http = httpRouter();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-brain-key, accept, mcp-session-id, mcp-protocol-version, last-event-id",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

type HttpCtx = Parameters<Parameters<typeof httpAction>[0]>[0];

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolCall = {
  name?: string;
  arguments?: Record<string, unknown>;
};

type ThoughtSearchResult = PublicThought & Record<string, unknown>;

type SemanticSearchResponse = {
  results: ThoughtSearchResult[];
  count: number;
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
  mode: "semantic";
};

type ListThoughtsResponse = {
  data: PublicThought[];
  total: number;
  page: number;
  per_page: number;
};

type CaptureThoughtArgs = FunctionArgs<typeof api.brain.captureThought>;
type TextSearchArgs = FunctionArgs<typeof api.brain.textSearch>;
type SemanticSearchArgs = FunctionArgs<typeof api.brain.semanticSearch>;
type RecallArgs = FunctionArgs<typeof api.agentMemory.recall>;
type WritebackArgs = FunctionArgs<typeof api.agentMemory.writeback>;
type ReportUsageArgs = FunctionArgs<typeof api.agentMemory.reportUsage>;
type ReviewMemoryArgs = FunctionArgs<typeof api.agentMemory.reviewMemory>;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function empty(status = 204): Response {
  return new Response(null, { status, headers: corsHeaders });
}

function unauthorized(): Response {
  return json({ error: "Invalid or missing access key" }, 401);
}

function auth(request: Request): boolean {
  const expected = process.env.MCP_ACCESS_KEY;
  const url = new URL(request.url);
  const provided = request.headers.get("x-brain-key") || url.searchParams.get("key");
  return Boolean(expected && provided && provided === expected);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

function numberParam(url: URL, key: string, fallback: number): number {
  const parsed = Number(url.searchParams.get(key));
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function restHandler(ctx: HttpCtx, request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return empty();
  if (!auth(request)) return unauthorized();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/open-brain-rest/, "") || "/";

  try {
    if (request.method === "GET" && path === "/health") {
      return json(await ctx.runQuery(api.brain.health, {}));
    }
    if (request.method === "GET" && path === "/stats") {
      return json(await ctx.runQuery(api.brain.stats, {
        days: url.searchParams.has("days") ? numberParam(url, "days", 0) : undefined,
        exclude_restricted: url.searchParams.get("exclude_restricted") !== "false",
      }));
    }
    if (request.method === "GET" && path === "/thoughts") {
      return json(await ctx.runQuery(api.brain.listThoughts, {
        page: numberParam(url, "page", 1),
        per_page: numberParam(url, "per_page", 25),
        type: url.searchParams.get("type") || undefined,
        source_type: url.searchParams.get("source_type") || undefined,
        status: url.searchParams.get("status") || undefined,
        importance_min: url.searchParams.has("importance_min") ? numberParam(url, "importance_min", 0) : undefined,
        quality_score_max: url.searchParams.has("quality_score_max") ? numberParam(url, "quality_score_max", 100) : undefined,
        sort: url.searchParams.get("sort") || undefined,
        order: url.searchParams.get("order") || undefined,
        exclude_restricted: url.searchParams.get("exclude_restricted") !== "false",
      }));
    }
    const thoughtMatch = path.match(/^\/thought\/([^/]+)$/);
    if (thoughtMatch && request.method === "GET") {
      const result = await ctx.runQuery(api.brain.getThought, {
        id: thoughtMatch[1],
        exclude_restricted: url.searchParams.get("exclude_restricted") !== "false",
      });
      if (!result) return json({ error: "Thought not found" }, 404);
      if ("restricted" in result) return json({ error: "Restricted thought" }, 403);
      return json(result);
    }
    if (thoughtMatch && request.method === "PUT") {
      const body = await readBody(request);
      return json(await ctx.runMutation(api.brain.updateThought, { id: thoughtMatch[1], ...body }));
    }
    if (thoughtMatch && request.method === "DELETE") {
      return json(await ctx.runMutation(api.brain.deleteThought, { id: thoughtMatch[1] }));
    }
    if (request.method === "POST" && path === "/capture") {
      return json(await ctx.runAction(api.brain.captureThought, (await readBody(request)) as CaptureThoughtArgs));
    }
    if (request.method === "POST" && path === "/search") {
      const body = await readBody(request);
      const mode = typeof body.mode === "string" ? body.mode : "semantic";
      if (mode === "text") return json(await ctx.runQuery(api.brain.textSearch, body as TextSearchArgs));
      return json(await ctx.runAction(api.brain.semanticSearch, body as SemanticSearchArgs));
    }
    if (request.method === "GET" && path === "/duplicates") {
      return json(await ctx.runQuery(api.brain.duplicates, {
        threshold: numberParam(url, "threshold", 0.85),
        limit: numberParam(url, "limit", 50),
        offset: numberParam(url, "offset", 0),
      }));
    }
    const reflectionMatch = path.match(/^\/thought\/([^/]+)\/reflection$/);
    if (reflectionMatch && request.method === "GET") {
      return json(await ctx.runQuery(api.brain.reflections, { thoughtId: reflectionMatch[1] }));
    }
    if (reflectionMatch && request.method === "POST") {
      return json(await ctx.runMutation(api.brain.addReflection, { thoughtId: reflectionMatch[1], ...(await readBody(request)) }));
    }
    const connectionsMatch = path.match(/^\/thought\/([^/]+)\/connections$/);
    if (connectionsMatch && request.method === "GET") {
      return json({ connections: [] });
    }
    if (request.method === "GET" && path === "/ingestion-jobs") return json({ jobs: [], count: 0 });
    if (request.method === "POST" && path === "/ingest") {
      const body = await readBody(request);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json({ error: "text is required" }, 400);
      const result = await ctx.runAction(api.brain.captureThought, { content: text, source_type: "dashboard_ingest" });
      return json({ job_id: 0, status: "complete", extracted_count: 1, thought_id: result.thought_id });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 500);
  }
}

async function agentMemoryHandler(ctx: HttpCtx, request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return empty();
  if (!auth(request)) return unauthorized();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/agent-memory-api/, "") || "/";

  try {
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, service: "agent-memory-api", backend: "convex", version: "0.1.0" });
    }
    if (request.method === "POST" && path === "/recall") {
      return json(await ctx.runAction(api.agentMemory.recall, (await readBody(request)) as RecallArgs));
    }
    if (request.method === "POST" && path === "/writeback") {
      const result = await ctx.runAction(api.agentMemory.writeback, (await readBody(request)) as WritebackArgs);
      if ("error" in result) return json(result, 422);
      return json(result);
    }
    const usageMatch = path.match(/^\/recall\/([^/]+)\/usage$/);
    if (usageMatch && request.method === "POST") {
      return json(await ctx.runMutation(api.agentMemory.reportUsage, { request_id: usageMatch[1], ...(await readBody(request)) } as ReportUsageArgs));
    }
    if (request.method === "GET" && path === "/memories/review") {
      const workspaceId = url.searchParams.get("workspace_id");
      if (!workspaceId) return json({ error: "workspace_id is required" }, 400);
      return json(await ctx.runQuery(api.agentMemory.reviewQueue, {
        workspace_id: workspaceId,
        project_id: url.searchParams.get("project_id") || undefined,
      }));
    }
    if (request.method === "GET" && path === "/memories") {
      const workspaceId = url.searchParams.get("workspace_id");
      if (!workspaceId) return json({ error: "workspace_id is required" }, 400);
      return json(await ctx.runQuery(api.agentMemory.memories, {
        workspace_id: workspaceId,
        project_id: url.searchParams.get("project_id") || undefined,
        review_status: url.searchParams.get("review_status") || undefined,
        lifecycle_status: url.searchParams.get("lifecycle_status") || undefined,
        runtime_name: url.searchParams.get("runtime_name") || undefined,
        memory_type: url.searchParams.get("memory_type") || undefined,
        task_id_prefix: url.searchParams.get("task_id_prefix") || undefined,
        limit: numberParam(url, "limit", 50),
      }));
    }
    const memoryReviewMatch = path.match(/^\/memories\/([^/]+)\/review$/);
    if (memoryReviewMatch && request.method === "PATCH") {
      return json(await ctx.runMutation(api.agentMemory.reviewMemory, { id: memoryReviewMatch[1], ...(await readBody(request)) } as ReviewMemoryArgs));
    }
    const memoryMatch = path.match(/^\/memories\/([^/]+)$/);
    if (memoryMatch && request.method === "GET") {
      const result = await ctx.runQuery(api.agentMemory.memory, { id: memoryMatch[1] });
      if (!result) return json({ error: "Memory not found" }, 404);
      return json(result);
    }
    const traceMatch = path.match(/^\/recall-traces\/([^/]+)$/);
    if (traceMatch && request.method === "GET") {
      const result = await ctx.runQuery(api.agentMemory.recallTrace, { request_id: traceMatch[1] });
      if (!result) return json({ error: "Recall trace not found" }, 404);
      return json(result);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 500);
  }
}

function mcpResult(id: JsonRpcRequest["id"], result: unknown): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result });
}

function mcpError(id: JsonRpcRequest["id"], message: string, code = -32000): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function mcpHandler(ctx: HttpCtx, request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return empty();
  if (!auth(request)) return unauthorized();
  if (request.method === "GET") {
    return json({ status: "ok", service: "convex-open-brain-mcp", transport: "streamable-http-json" });
  }
  const rpc = (await request.json().catch(() => ({}))) as JsonRpcRequest;
  if (rpc.method === "initialize") {
    return mcpResult(rpc.id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "convex-open-brain", version: "0.1.0" },
    });
  }
  if (rpc.method === "tools/list") {
    return mcpResult(rpc.id, {
      tools: [
        { name: "search", description: "Search Open Brain memories by meaning.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "fetch", description: "Fetch one Open Brain thought by ID.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
        { name: "search_thoughts", description: "Search captured thoughts by meaning.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" }, threshold: { type: "number" } }, required: ["query"] } },
        { name: "list_thoughts", description: "List recently captured thoughts.", inputSchema: { type: "object", properties: { limit: { type: "number" }, type: { type: "string" } } } },
        { name: "thought_stats", description: "Get captured thought statistics.", inputSchema: { type: "object", properties: {} } },
        { name: "capture_thought", description: "Save a new thought to Open Brain.", inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } },
      ],
    });
  }
  if (rpc.method !== "tools/call") return mcpError(rpc.id, `Unsupported MCP method: ${rpc.method}`, -32601);

  const call = (rpc.params || {}) as ToolCall;
  const args = call.arguments || {};
  try {
    if (call.name === "search" || call.name === "search_thoughts") {
      const query = typeof args.query === "string" ? args.query : "";
      const result: SemanticSearchResponse = await ctx.runAction(api.brain.semanticSearch, {
        query,
        limit: typeof args.limit === "number" ? args.limit : 10,
        threshold: typeof args.threshold === "number" ? args.threshold : 0.5,
        exclude_restricted: true,
      });
      if (call.name === "search") {
        return mcpResult(rpc.id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              results: result.results.map((thought: ThoughtSearchResult) => ({
                id: thought.id,
                title: thoughtTitle(thought.content, thought.created_at),
                url: thoughtUrl(thought.id),
              })),
            }),
          }],
        });
      }
      const text = result.results.map((thought: ThoughtSearchResult, index: number) => {
        const topics = Array.isArray(thought.metadata.topics) ? `\nTopics: ${thought.metadata.topics.join(", ")}` : "";
        return `--- Result ${index + 1} (${Math.round(Number(thought.similarity || 0) * 100)}% match) ---\nCaptured: ${new Date(thought.created_at).toLocaleDateString()}\nType: ${thought.type}${topics}\n\n${thought.content}`;
      }).join("\n\n");
      return mcpResult(rpc.id, { content: [{ type: "text", text: text || `No thoughts found matching "${query}".` }] });
    }
    if (call.name === "fetch") {
      const id = typeof args.id === "string" ? args.id : "";
      const thought = await ctx.runQuery(api.brain.getThought, { id, exclude_restricted: true });
      if (!thought || "restricted" in thought) return mcpError(rpc.id, "Thought not found", -32602);
      return mcpResult(rpc.id, {
        content: [{
          type: "text",
          text: JSON.stringify({
            id: thought.id,
            title: thoughtTitle(thought.content, thought.created_at),
            text: thought.content,
            url: thoughtUrl(thought.id),
            metadata: thought.metadata,
          }),
        }],
      });
    }
    if (call.name === "list_thoughts") {
      const result: ListThoughtsResponse = await ctx.runQuery(api.brain.listThoughts, {
        per_page: typeof args.limit === "number" ? args.limit : 10,
        type: typeof args.type === "string" ? args.type : undefined,
        exclude_restricted: true,
      });
      const text = result.data.map((thought: PublicThought, index: number) => `${index + 1}. [${new Date(thought.created_at).toLocaleDateString()}] (${thought.type})\n   ${thought.content}`).join("\n\n");
      return mcpResult(rpc.id, { content: [{ type: "text", text: text || "No thoughts found." }] });
    }
    if (call.name === "thought_stats") {
      const stats = await ctx.runQuery(api.brain.stats, { exclude_restricted: true });
      return mcpResult(rpc.id, { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] });
    }
    if (call.name === "capture_thought") {
      const content = typeof args.content === "string" ? args.content : "";
      const result = await ctx.runAction(api.brain.captureThought, { content, source_type: "mcp" });
      return mcpResult(rpc.id, { content: [{ type: "text", text: `Captured as ${result.type}` }] });
    }
    return mcpError(rpc.id, `Unknown tool: ${call.name}`, -32602);
  } catch (error) {
    return mcpError(rpc.id, error instanceof Error ? error.message : "Tool call failed");
  }
}

http.route({ pathPrefix: "/", method: "OPTIONS", handler: httpAction(restHandler) });
http.route({ path: "/health", method: "GET", handler: httpAction(restHandler) });
http.route({ path: "/stats", method: "GET", handler: httpAction(restHandler) });
http.route({ path: "/thoughts", method: "GET", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/thought/", method: "GET", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/thought/", method: "PUT", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/thought/", method: "DELETE", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/thought/", method: "POST", handler: httpAction(restHandler) });
http.route({ path: "/capture", method: "POST", handler: httpAction(restHandler) });
http.route({ path: "/search", method: "POST", handler: httpAction(restHandler) });
http.route({ path: "/duplicates", method: "GET", handler: httpAction(restHandler) });
http.route({ path: "/ingestion-jobs", method: "GET", handler: httpAction(restHandler) });
http.route({ path: "/ingest", method: "POST", handler: httpAction(restHandler) });

http.route({ path: "/agent-memory-api/health", method: "GET", handler: httpAction(agentMemoryHandler) });
http.route({ path: "/agent-memory-api/recall", method: "POST", handler: httpAction(agentMemoryHandler) });
http.route({ path: "/agent-memory-api/writeback", method: "POST", handler: httpAction(agentMemoryHandler) });
http.route({ pathPrefix: "/agent-memory-api/recall/", method: "POST", handler: httpAction(agentMemoryHandler) });
http.route({ path: "/agent-memory-api/memories", method: "GET", handler: httpAction(agentMemoryHandler) });
http.route({ path: "/agent-memory-api/memories/review", method: "GET", handler: httpAction(agentMemoryHandler) });
http.route({ pathPrefix: "/agent-memory-api/memories/", method: "GET", handler: httpAction(agentMemoryHandler) });
http.route({ pathPrefix: "/agent-memory-api/memories/", method: "PATCH", handler: httpAction(agentMemoryHandler) });
http.route({ pathPrefix: "/agent-memory-api/recall-traces/", method: "GET", handler: httpAction(agentMemoryHandler) });

http.route({ path: "/mcp", method: "GET", handler: httpAction(mcpHandler) });
http.route({ path: "/mcp", method: "POST", handler: httpAction(mcpHandler) });

http.route({ path: "/open-brain-rest/health", method: "GET", handler: httpAction(restHandler) });
http.route({ path: "/open-brain-rest/capture", method: "POST", handler: httpAction(restHandler) });
http.route({ path: "/open-brain-rest/search", method: "POST", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/open-brain-rest/", method: "GET", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/open-brain-rest/", method: "POST", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/open-brain-rest/", method: "PUT", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/open-brain-rest/", method: "PATCH", handler: httpAction(restHandler) });
http.route({ pathPrefix: "/open-brain-rest/", method: "DELETE", handler: httpAction(restHandler) });

export default http;
