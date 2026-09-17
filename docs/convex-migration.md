# Convex Migration Checklist

OB1 now treats Convex as the default backend. Supabase remains in the repo only as a legacy validation path while existing installs migrate.

## New Method

Use [`integrations/convex-open-brain`](../integrations/convex-open-brain/) for:

- REST dashboard API
- MCP endpoint
- Agent Memory recall/write-back/review APIs
- vector search over OpenRouter/OpenAI-compatible embeddings
- Python and Node import ingestion through HTTP `/capture`

Required `.env.local` values:

```bash
CONVEX_DEPLOYMENT=dev:your-deployment
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
MCP_ACCESS_KEY=your-generated-access-key
OPENROUTER_API_KEY=sk-or-v1-...
```

Dashboard values:

```bash
NEXT_PUBLIC_API_URL=https://your-deployment.convex.site
AGENT_MEMORY_API_URL=https://your-deployment.convex.site/agent-memory-api
SESSION_SECRET="$(openssl rand -hex 32)"
```

Importer values:

```bash
OB1_API_URL=https://your-deployment.convex.site
OB1_API_KEY=your-generated-access-key
```

## Contract Preservation

| Existing Pattern | Convex Replacement |
| --- | --- |
| `open-brain-rest` Supabase Edge Function | Convex HTTP actions at `.convex.site` |
| `agent-memory-api` Supabase Edge Function | Convex HTTP actions under `/agent-memory-api` |
| `match_thoughts` pgvector RPC | Convex vector index + `ctx.vectorSearch` |
| `x-brain-key` auth | unchanged |
| OpenRouter embeddings/classification | unchanged |
| Python direct Supabase inserts | HTTP `/capture` with `OB1_API_URL` and `OB1_API_KEY` |
| MCP Streamable HTTP endpoint | Convex `/mcp` JSON-RPC tool endpoint |

## Legacy Validation

Old methods should still be testable until removed intentionally:

```bash
OB1_REST_URL="https://YOUR_PROJECT_REF.supabase.co/functions/v1/open-brain-rest" \
OB1_REST_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/open-brain-rest/smoke/live-smoke.mjs
```

```bash
OB1_AGENT_MEMORY_ENDPOINT="https://YOUR_PROJECT_REF.supabase.co/functions/v1/agent-memory-api" \
OB1_AGENT_MEMORY_KEY="YOUR_MCP_ACCESS_KEY" \
node integrations/agent-memory-api/smoke/live-smoke.mjs
```

## Follow-Up Audit

Run this before declaring a migration slice complete:

```bash
rg -n "Supabase|supabase|SUPABASE|service_role|pgvector|functions/v1" \
  README.md docs integrations extensions recipes dashboards server schemas skills
```

Every remaining hit should be one of:

- legacy validation documentation
- historical contribution text
- a Supabase-specific legacy integration
- migration notes explaining the Convex replacement
