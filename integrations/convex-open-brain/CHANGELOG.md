# Changelog

## Unreleased

- Expose structured Agent Memory recall, pending writeback, and usage reporting
  through the existing authenticated MCP endpoint.
- Scope memory idempotency to workspace and project while preserving legacy
  same-scope replay keys with an additive index.
- Allow independent HTTPS classification credentials and endpoint; keep existing
  OpenRouter embedding configuration and model unchanged.
- Add runtime-neutral memory skill, T3/CLIProxyAPI setup, and live MCP memory smoke.
- Add isolated standalone MCP bundle/skill installation, private CLIProxyAPI
  classification profile, macOS login service, and real proxy smoke validation.
  Standalone setup disconnects the prior shared Codex entry without adding T3 hooks.
- Connect development classification through approved Tailscale Funnel HTTPS;
  verify authenticated public proxy and hosted model extraction, preserve
  embedding settings, and document private backup and rollback.
- Add repeatable hosted classification smoke with explicit-person verification
  and test-thought cleanup.

Practical OB1 systems from Nate B. Jones:
[Substack](https://substack.com/@natesnewsletter),
[natebjones.com](https://natebjones.com).
