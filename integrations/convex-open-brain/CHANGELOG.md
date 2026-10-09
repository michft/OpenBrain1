# Changelog

## Unreleased

- Expose structured Agent Memory recall, pending writeback, and usage reporting
  through the existing authenticated MCP endpoint.
- Scope memory idempotency to workspace and project while preserving legacy
  same-scope replay keys with an additive index.
- Allow independent HTTPS classification credentials and endpoint; keep existing
  OpenRouter embedding configuration and model unchanged.
- Add runtime-neutral memory skill, T3/CLIProxyAPI setup, and live MCP memory smoke.

Practical OB1 systems from Nate B. Jones:
[Substack](https://substack.com/@natesnewsletter),
[natebjones.com](https://natebjones.com).
