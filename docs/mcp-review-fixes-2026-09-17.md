# MCP Review Fixes — 2026-09-17

Scope: verify supplied PR findings against the current development code, apply minimal fixes, and validate locally. No production deployment.

## Findings

| Finding | Verified change |
| --- | --- |
| Checkout credentials | Disabled persisted checkout credentials before dependency installation. |
| Action versions | Pinned checkout v4.2.2, pnpm/action-setup v4.1.0, and setup-node v4.4.0 to full upstream-verified commit SHAs. |
| Package runner conflict | Changed the integration's AGENTS installation example to `pnpm exec`; retained the root npm/yarn prohibition. |
| Browser credentials | Removed public MCP environment examples, proxy fallbacks, and types. Existing authenticated server proxy uses private variables. |
| Component example imports | Added mutation, validator, and auth imports to the app example. |
| Component object syntax | Replaced the “Good” example's semicolon with a comma. |
| Migration list numbering | Restarted each separate migration-phase list at 1. |
| Hot-path contents numbering | Escaped literal numbered heading labels inside bullets, avoiding unintended nested ordered lists. |
| Auth list numbering | Restored sequential workflow numbering without reordering steps. |
| Memory listing bounds | Replaced workspace collection with descending indexed pages; HTTP fills filtered pages with a 20-page scan budget and explicit continuation/scan-limit metadata. |
| Review action validation | Rejects unsupported actions and relation parameters before writes or audit events. Removed unreachable relation insertion. |
| Duplicate scan bounds | Recent 90-day/200-candidate scan; bounded fingerprint lookups; preserved threshold and result pagination. |
| Model metadata | Removes unsupported values before validated mutation; falls back when nothing supported remains. |
| Path/body overrides | URL IDs override body IDs at all four mutation call sites. |
| ID validation | Explicit-table normalization before thought/memory access; malformed/wrong-table IDs preserve not-found handling. Relation insertion is unavailable through review. |
| OpenRouter timeouts | Both requests have 20-second deadlines; metadata errors fall back, embedding errors propagate. |
| Import success | Successful HTTP 200/201 captures set `ok: true`; existing non-success JSON behavior retained. |
| Transcript retention | Default imports keep distilled thoughts only; `--retain-transcript` explicitly opts in. |
| Local Ollama environment | Restored Supabase variables required by the existing embedding script. |

All findings were still applicable, with location/wording corrections: the runner conflict was in the integration's AGENTS file; the auth workflow had a missing sequential prefix. No unrelated runtime migration was attempted.

## Verification

- `pnpm typecheck` — passed.
- `pnpm test` — 47 tests passed across six Convex test files, including malformed/wrong-table IDs, URL/body conflicts, sparse filtered pagination with continuation, review rejection without side effects, model metadata, request timeouts, and bounded duplicate scans.
- `python3 -m unittest discover -s recipes/chatgpt-conversation-import -p test_import_chatgpt.py -v` — four tests passed; Python compilation also passed.
- `pnpm dlx markdownlint-cli2 --config .github/.markdownlint.jsonc` with all 204 JJ-tracked Markdown paths — zero issues.
- Workflow YAML parsed with Ruby; all action refs have full commit SHAs and checkout credentials are disabled. Upstream tags verified using `git ls-remote` (including the dereferenced pnpm v4.1.0 annotated tag).
- Dashboard proxy TypeScript transpilation and checks for private credentials/auth guard passed. Full Svelte checking was unavailable because dashboard dependencies are not installed.
- `git diff --check` — passed. Git was used only for upstream tag inspection and whitespace validation; JJ manages local changes.

Validation tooling notes: Python's YAML module was unavailable, so the YAML check used Ruby's installed parser. The CI Markdown glob includes nested dependency directories on a populated developer checkout; that local run was stopped, then repeated successfully using all tracked Markdown files (the CI checkout has no installed dependencies).

### Local CodeRabbit Review

`coderabbit review --agent --uncommitted --include-untracked` completed with five entries representing three distinct findings:

- **Fixed:** cap sparse pagination scans, retain accumulated matches, and expose continuation when the budget is exhausted (reported twice).
- **Fixed:** assert descending memory order and unique IDs across pages.
- **Skipped:** change non-success importer JSON to force `ok: false` (reported twice). The requested fix explicitly preserves existing non-success handling; this behavior change was not applied. A malformed upstream error body claiming success remains an existing edge case.

Parent review additionally guards duplicate detection against stale stored fingerprints; a regression test verifies that changed content cannot become a false exact match.

### PR CI Failure

PR [#2](https://github.com/michft/OpenBrain1/pull/2) at `7672b495` passed Convex MCP checks but failed [Markdown lint](https://github.com/michft/OpenBrain1/actions/runs/35183961927) with 41 issues in six files. Review fixes covered three of those files; remaining blank lines, separate dashboard callouts, and generated table formatting are now corrected. The complete tracked Markdown set passes locally.

After pushing the review fixes, Markdown lint passed on GitHub. The separate [gate startup failure](https://github.com/michft/OpenBrain1/actions/runs/35192022056) exposes a workflow annotation: the embedded run script exceeds the 21,000-byte expression limit (21,049 UTF-8 bytes despite only 20,715 characters). Decorative comment separators were shortened to fit the limit. Check logic and enforcement remain unchanged; the previous jobless failure was a workflow validation error, not a completed gate review.

At `a363903b`, Markdown lint and Convex checks both passed. The gate then reached its script but exited before producing an artifact: an optional author suffix used a command substitution returning status 1 when no GitHub handle was present. Under `bash -e`, the enclosing assignment stopped execution. The suffix now uses an explicit conditional, verified with the empty-handle case; validation rules remain unchanged.

Linear NAT-833 remains unavailable through the configured account (previous lookup returned `Entity not found`); this document records the implementation checkpoint.
