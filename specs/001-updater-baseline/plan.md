# Plan: Dynamic DNS sessions and restricted control planes

The [specification](spec.md) preserves existing behavior. Use the project guide
and constitution for implementation constraints. Keep upstream-managed templates,
helpers, and integration manifests unchanged.

## Source ownership

- `cli.ts`
- `app.ts`
- `mcp.ts`
- `lib/updater.ts`
- `lib/config-file.ts`
- `lib/providers`
- `lib/schemas`
- `lib/safe-https.ts`
- `lib/state.ts`
- `lib/mcp`
- `tests`

## Constitution check

Preserve the existing constitution, canonical source ownership, explicit operational authority, deterministic failure behavior, and native validation. This retrospective baseline changes project-owned documentation; it introduces no live deployment, credentials, privileged action, or product release.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm run verify
python3 scripts/ci/check-site-accessibility.py
python3 scripts/ci/check-site-links.py
bash scripts/ci/check-site-responsive.sh
actionlint
zizmor --offline --min-severity medium --min-confidence medium .github
```

Run checks in an isolated checkout. Commands are instructions, not evidence of
a pass. Record results in `coverage.md`, keep incomplete work in `tasks.md`, and
follow `RELEASING.md` for reviewed delivery. No live operation is required solely
to create this retrospective baseline.

## Legacy completion audit, 2026-09-06

Map all provider adapters, six CLI commands, 16 MCP tools, shared update/configuration
logic, persistence, outbound policies, and support surfaces to concrete contracts.
Keep existing detailed configuration/provider guides as normative references.
Centralize initializer field validation so CLI and elicited MCP templates cannot
emit intervals rejected by runtime or extra assignments from multiline hosts.
Prove rejection before writes, preserve force/elicitation behavior, and run native
verification with stubbed providers. Review and merge with exact-head hosted checks.
