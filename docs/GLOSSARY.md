# OB1 Integration Glossary

| Term | Meaning |
| --- | --- |
| Thought | Captured note exposed by the existing six thought MCP tools. |
| Agent Memory | Structured operational knowledge with scope, provenance, freshness, and use policy. |
| Evidence | Memory that may inform work without becoming an instruction. |
| Instruction-grade memory | Memory explicitly permitted for instruction use after human confirmation or trusted import. |
| Workspace / project | Context selectors within the current shared private brain, not separate authenticated tenant identities. |
| Runtime | Agent host using OB1; T3 Code and OpenClaw are examples. |
| CLIProxyAPI | Model API gateway used by an agent or metadata classifier; OB1 MCP remains separate. |
| Classification | Metadata extraction from captured thoughts through a chat-completions endpoint. |
| Embedding | Vector used for semantic retrieval; existing storage expects 1536 dimensions from the configured model. |
| Handoff | Bounded context transferred to another agent or human; not automatically durable memory. |
| Idempotency | Same workspace/project and writeback key replay without creating another memory row. |
