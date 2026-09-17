import { httpRouter } from "convex/server";
import type { FunctionArgs } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
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
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
};

type ToolCall = {
  name?: unknown;
  arguments?: unknown;
};

type JsonRpcId = string | number | null;
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string } };

type AuthResult = { authorized: boolean; admin: boolean };

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

type CaptureThoughtArgs = FunctionArgs<typeof internal.brain.captureThought>;
type TextSearchArgs = FunctionArgs<typeof internal.brain.textSearch>;
type SemanticSearchArgs = FunctionArgs<typeof internal.brain.semanticSearch>;
type RecallArgs = FunctionArgs<typeof internal.agentMemory.recall>;
type WritebackArgs = FunctionArgs<typeof internal.agentMemory.writeback>;
type ReportUsageArgs = FunctionArgs<typeof internal.agentMemory.reportUsage>;
type ReviewMemoryArgs = FunctionArgs<typeof internal.agentMemory.reviewMemory>;

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

function auth(request: Request): AuthResult {
  const accessKey = process.env.MCP_ACCESS_KEY;
  const adminKey = process.env.MCP_ADMIN_KEY;
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = request.headers.get("x-brain-key") || bearer || url.searchParams.get("key");
  const agent = Boolean(accessKey && provided && provided === accessKey);
  const admin = Boolean(adminKey && provided && provided === adminKey && adminKey !== accessKey);
  return { authorized: agent || admin, admin };
}

function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const allowed = (process.env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return origin === new URL(request.url).origin || allowed.includes(origin);
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
  if (!auth(request).authorized) return unauthorized();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/open-brain-rest/, "") || "/";

  try {
    if (request.method === "GET" && path === "/health") {
      return json(await ctx.runQuery(internal.brain.health, {}));
    }
    if (request.method === "GET" && path === "/stats") {
      return json(await ctx.runQuery(internal.brain.stats, {
        days: url.searchParams.has("days") ? numberParam(url, "days", 0) : undefined,
        exclude_restricted: url.searchParams.get("exclude_restricted") !== "false",
      }));
    }
    if (request.method === "GET" && path === "/thoughts") {
      return json(await ctx.runQuery(internal.brain.listThoughts, {
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
      const result = await ctx.runQuery(internal.brain.getThought, {
        id: thoughtMatch[1],
        exclude_restricted: url.searchParams.get("exclude_restricted") !== "false",
      });
      if (!result) return json({ error: "Thought not found" }, 404);
      if ("restricted" in result) return json({ error: "Restricted thought" }, 403);
      return json(result);
    }
    if (thoughtMatch && request.method === "PUT") {
      const body = await readBody(request);
      return json(await ctx.runMutation(internal.brain.updateThought, { id: thoughtMatch[1], ...body }));
    }
    if (thoughtMatch && request.method === "DELETE") {
      return json(await ctx.runMutation(internal.brain.deleteThought, { id: thoughtMatch[1] }));
    }
    if (request.method === "POST" && path === "/capture") {
      return json(await ctx.runAction(internal.brain.captureThought, (await readBody(request)) as CaptureThoughtArgs));
    }
    if (request.method === "POST" && path === "/search") {
      const body = await readBody(request);
      const mode = typeof body.mode === "string" ? body.mode : "semantic";
      if (mode === "text") return json(await ctx.runQuery(internal.brain.textSearch, body as TextSearchArgs));
      return json(await ctx.runAction(internal.brain.semanticSearch, body as SemanticSearchArgs));
    }
    if (request.method === "GET" && path === "/duplicates") {
      return json(await ctx.runQuery(internal.brain.duplicates, {
        threshold: numberParam(url, "threshold", 0.85),
        limit: numberParam(url, "limit", 50),
        offset: numberParam(url, "offset", 0),
      }));
    }
    const reflectionMatch = path.match(/^\/thought\/([^/]+)\/reflection$/);
    if (reflectionMatch && request.method === "GET") {
      return json(await ctx.runQuery(internal.brain.reflections, { thoughtId: reflectionMatch[1] }));
    }
    if (reflectionMatch && request.method === "POST") {
      return json(await ctx.runMutation(internal.brain.addReflection, { thoughtId: reflectionMatch[1], ...(await readBody(request)) }));
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
      const result = await ctx.runAction(internal.brain.captureThought, { content: text, source_type: "dashboard_ingest" });
      return json({ job_id: 0, status: "complete", extracted_count: 1, thought_id: result.thought_id });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 500);
  }
}

async function agentMemoryHandler(ctx: HttpCtx, request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return empty();
  const access = auth(request);
  if (!access.authorized) return unauthorized();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/agent-memory-api/, "") || "/";

  try {
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, service: "agent-memory-api", backend: "convex", version: "0.1.0" });
    }
    if (request.method === "POST" && path === "/recall") {
      return json(await ctx.runAction(internal.agentMemory.recall, (await readBody(request)) as RecallArgs));
    }
    if (request.method === "POST" && path === "/writeback") {
      const body = await readBody(request);
      const result = await ctx.runAction(internal.agentMemory.writeback, { ...body, trusted_writeback: access.admin } as WritebackArgs);
      if ("error" in result) return json(result, 422);
      return json(result);
    }
    const usageMatch = path.match(/^\/recall\/([^/]+)\/usage$/);
    if (usageMatch && request.method === "POST") {
      return json(await ctx.runMutation(internal.agentMemory.reportUsage, { request_id: usageMatch[1], ...(await readBody(request)) } as ReportUsageArgs));
    }
    if (request.method === "GET" && path === "/memories/review") {
      const workspaceId = url.searchParams.get("workspace_id");
      if (!workspaceId) return json({ error: "workspace_id is required" }, 400);
      return json(await ctx.runQuery(internal.agentMemory.reviewQueue, {
        workspace_id: workspaceId,
        project_id: url.searchParams.get("project_id") || undefined,
      }));
    }
    if (request.method === "GET" && path === "/memories") {
      const workspaceId = url.searchParams.get("workspace_id");
      if (!workspaceId) return json({ error: "workspace_id is required" }, 400);
      return json(await ctx.runQuery(internal.agentMemory.memories, {
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
      if (!access.admin) return json({ error: "Admin access required" }, 403);
      return json(await ctx.runMutation(internal.agentMemory.reviewMemory, { id: memoryReviewMatch[1], ...(await readBody(request)) } as ReviewMemoryArgs));
    }
    const memoryMatch = path.match(/^\/memories\/([^/]+)$/);
    if (memoryMatch && request.method === "GET") {
      const result = await ctx.runQuery(internal.agentMemory.memory, { id: memoryMatch[1] });
      if (!result) return json({ error: "Memory not found" }, 404);
      return json(result);
    }
    const traceMatch = path.match(/^\/recall-traces\/([^/]+)$/);
    if (traceMatch && request.method === "GET") {
      const result = await ctx.runQuery(internal.agentMemory.recallTrace, { request_id: traceMatch[1] });
      if (!result) return json({ error: "Recall trace not found" }, 404);
      return json(result);
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 500);
  }
}

const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

const MCP_TOOLS = [
  {
    name: "search",
    description: "Search Open Brain memories by meaning.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        threshold: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: "Fetch one Open Brain thought by ID.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"] },
  },
  {
    name: "search_thoughts",
    description: "Search captured thoughts by meaning.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        threshold: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["query"],
    },
  },
  {
    name: "list_thoughts",
    description: "List recently captured thoughts.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, type: { type: "string", minLength: 1 } },
    },
  },
  {
    name: "thought_stats",
    description: "Get captured thought statistics.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "capture_thought",
    description: "Save a new thought to Open Brain.",
    inputSchema: { type: "object", properties: { content: { type: "string", minLength: 1, maxLength: 15000 } }, required: ["content"] },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, message: string, code = -32000): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResponse(response: JsonRpcResponse | JsonRpcResponse[], status = 200): Response {
  return json(response, status);
}

function parseRpcRequest(value: unknown): JsonRpcRequest | null {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.trim() === "") return null;
  if (Object.prototype.hasOwnProperty.call(value, "id") && !isRpcId(value.id)) return null;
  return value as unknown as JsonRpcRequest;
}

function requestId(rpc: JsonRpcRequest): { id: JsonRpcId; notification: boolean } {
  const notification = !Object.prototype.hasOwnProperty.call(rpc, "id");
  return { id: notification ? null : (rpc.id ?? null), notification };
}

function requiredString(args: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function boundedInteger(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number | null {
  const value = args[key];
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function boundedNumber(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number | null {
  const value = args[key];
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

async function dispatchMcp(ctx: HttpCtx, rpc: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, notification } = requestId(rpc);

  if (rpc.method === "notifications/initialized") return rpcResult(id, {});
  if (rpc.method === "ping") return rpcResult(id, {});
  if (rpc.method === "initialize") {
    const params = rpc.params === undefined ? {} : rpc.params;
    if (
      !isRecord(params)
      || typeof params.protocolVersion !== "string"
      || params.protocolVersion.trim() === ""
      || !isRecord(params.capabilities)
      || !isRecord(params.clientInfo)
      || typeof params.clientInfo.name !== "string"
      || params.clientInfo.name.trim() === ""
      || typeof params.clientInfo.version !== "string"
      || params.clientInfo.version.trim() === ""
    ) return rpcError(id, "initialize params require protocolVersion, capabilities, and clientInfo name/version", -32602);
    const requested = params.protocolVersion;
    const protocolVersion = requested && MCP_PROTOCOL_VERSIONS.includes(requested as (typeof MCP_PROTOCOL_VERSIONS)[number])
      ? requested
      : MCP_PROTOCOL_VERSIONS[0];
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "convex-open-brain", version: "0.1.0" },
    });
  }
  if (rpc.method === "tools/list") {
    if (rpc.params !== undefined && !isRecord(rpc.params)) return rpcError(id, "tools/list params must be an object", -32602);
    return rpcResult(id, { tools: MCP_TOOLS });
  }
  if (rpc.method !== "tools/call") return rpcError(id, `Unsupported MCP method: ${rpc.method}`, -32601);
  if (notification) return rpcError(id, "tools/call requests require an id", -32600);
  if (!isRecord(rpc.params)) return rpcError(id, "tools/call params must be an object", -32602);

  const call = rpc.params as ToolCall;
  if (typeof call.name !== "string" || call.name.trim() === "") return rpcError(id, "Tool name is required", -32602);
  if (call.arguments !== undefined && !isRecord(call.arguments)) return rpcError(id, "Tool arguments must be an object", -32602);
  const args = (call.arguments as Record<string, unknown> | undefined) || {};

  try {
    if (call.name === "search" || call.name === "search_thoughts") {
      const query = requiredString(args, "query", 2000);
      const limit = boundedInteger(args, "limit", 10, 1, 50);
      const threshold = boundedNumber(args, "threshold", 0.5, 0, 1);
      if (!query) return rpcError(id, "query must be a non-empty string of at most 2000 characters", -32602);
      if (limit === null) return rpcError(id, "limit must be an integer between 1 and 50", -32602);
      if (threshold === null) return rpcError(id, "threshold must be a number between 0 and 1", -32602);
      const result: SemanticSearchResponse = await ctx.runAction(internal.brain.semanticSearch, {
        query,
        limit,
        threshold,
        exclude_restricted: true,
      });
      if (call.name === "search") {
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify({ results: result.results.map((thought: ThoughtSearchResult) => ({
            id: thought.id,
            title: thoughtTitle(thought.content, thought.created_at),
            url: thoughtUrl(thought.id),
          })) }) }],
        });
      }
      const text = result.results.map((thought: ThoughtSearchResult, index: number) => {
        const topics = Array.isArray(thought.metadata.topics) ? `\nTopics: ${thought.metadata.topics.join(", ")}` : "";
        return `--- Result ${index + 1} (${Math.round(Number(thought.similarity || 0) * 100)}% match) ---\nCaptured: ${new Date(thought.created_at).toLocaleDateString()}\nType: ${thought.type}${topics}\n\n${thought.content}`;
      }).join("\n\n");
      return rpcResult(id, { content: [{ type: "text", text: text || `No thoughts found matching "${query}".` }] });
    }
    if (call.name === "fetch") {
      const thoughtId = requiredString(args, "id", 256);
      if (!thoughtId) return rpcError(id, "id must be a non-empty string", -32602);
      const thought = await ctx.runQuery(internal.brain.getThought, { id: thoughtId, exclude_restricted: true });
      if (!thought || "restricted" in thought) return rpcError(id, "Thought not found", -32602);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify({
          id: thought.id,
          title: thoughtTitle(thought.content, thought.created_at),
          text: thought.content,
          url: thoughtUrl(thought.id),
          metadata: thought.metadata,
        }) }],
      });
    }
    if (call.name === "list_thoughts") {
      const limit = boundedInteger(args, "limit", 10, 1, 100);
      const type = args.type === undefined ? undefined : requiredString(args, "type", 100);
      if (limit === null) return rpcError(id, "limit must be an integer between 1 and 100", -32602);
      if (args.type !== undefined && !type) return rpcError(id, "type must be a non-empty string", -32602);
      const result: ListThoughtsResponse = await ctx.runQuery(internal.brain.listThoughts, {
        per_page: limit,
        type: type || undefined,
        exclude_restricted: true,
      });
      const text = result.data.map((thought: PublicThought, index: number) => `${index + 1}. [${new Date(thought.created_at).toLocaleDateString()}] (${thought.type})\n   ${thought.content}`).join("\n\n");
      return rpcResult(id, { content: [{ type: "text", text: text || "No thoughts found." }] });
    }
    if (call.name === "thought_stats") {
      const stats = await ctx.runQuery(internal.brain.stats, { exclude_restricted: true });
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] });
    }
    if (call.name === "capture_thought") {
      const content = requiredString(args, "content", 15000);
      if (!content) return rpcError(id, "content must be a non-empty string of at most 15000 characters", -32602);
      const result = await ctx.runAction(internal.brain.captureThought, { content, source_type: "mcp" });
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ thought_id: result.thought_id, type: result.type }) }] });
    }
    return rpcError(id, `Unknown tool: ${call.name}`, -32602);
  } catch (error) {
    return rpcResult(id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : "Tool call failed" }],
      isError: true,
    });
  }
}

async function mcpHandler(ctx: HttpCtx, request: Request): Promise<Response> {
  if (!originAllowed(request)) return json({ error: "Untrusted Origin" }, 403);
  if (request.method === "OPTIONS") return empty();
  if (!auth(request).authorized) return unauthorized();
  const protocolHeader = request.headers.get("mcp-protocol-version");
  if (protocolHeader && !MCP_PROTOCOL_VERSIONS.includes(protocolHeader.trim() as (typeof MCP_PROTOCOL_VERSIONS)[number])) {
    return json({ error: "Unsupported MCP protocol version" }, 400);
  }
  if (request.method === "GET" || request.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return rpcResponse(rpcError(null, "Parse error", -32700), 400);
  }
  const batch = Array.isArray(input);
  const values: unknown[] = Array.isArray(input) ? input : [input];
  if (values.length === 0) return rpcResponse(rpcError(null, "Invalid Request", -32600), 400);

  const responses: JsonRpcResponse[] = [];
  for (const value of values) {
    const rpc = parseRpcRequest(value);
    if (!rpc) {
      responses.push(rpcError(null, "Invalid Request", -32600));
      continue;
    }
    const response = await dispatchMcp(ctx, rpc);
    if (Object.prototype.hasOwnProperty.call(rpc, "id")) responses.push(response);
  }
  if (responses.length === 0) return empty(202);
  return rpcResponse(batch ? responses : responses[0]);
}

http.route({ path: "/mcp", method: "OPTIONS", handler: httpAction(mcpHandler) });
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
