# AGENTS.md

## Scope and priorities

This file applies to the entire repository. Follow the user's request first,
then this file, then the detailed project documentation. Keep changes narrowly
scoped and preserve unrelated work already present in the worktree.

uDDNS is a security-sensitive TypeScript ESM service that discovers public IP
addresses and updates DNS through multiple providers. Treat network access,
credentials, host selection, and DNS writes as safety boundaries.

## Repository map

- `app.ts`: updater daemon entry point.
- `cli.ts`: unified CLI and packaged `uddns` binary.
- `mcp.ts`: stdio/HTTP MCP server entry point.
- `lib/`: runtime, configuration, schemas, safety controls, and providers.
- `lib/providers/`: provider implementations and shared HTTP clients.
- `lib/mcp/`: MCP tools, resources, prompts, transports, and sessions.
- `tests/`: deterministic core, provider, MCP, docs-contract, and live tests.
- `tests/helpers/`: shared fixtures; use these instead of custom global mocks.
- `.env.example`: canonical environment-variable reference.
- `docs/development.md`: architecture and contributor workflow.
- `docs/security.md`: outbound network and secret-handling requirements.

Generated `dist/` and `coverage/` contents must not be edited by hand.

## Toolchain and commands

Use Node.js 24, pnpm 11, and Vite+ (`vp`) as pinned in `package.json`.
Prefer repository scripts over invoking underlying tools directly.

```bash
vp install                         # install dependencies
vp test tests/foo.test.ts          # focused test file
vp test tests/providers            # focused test directory
vp check                           # format check + lint + typecheck
vp run docs:check                  # documentation contracts
vp run build                       # emit dist/
vp run lean:check                  # dead code and dependency check
vp run verify                      # full pre-commit verification
```

During iteration, run the smallest relevant test set. Before handing off a
substantial code change, run `vp check` plus relevant tests. Run
`vp run verify` for cross-cutting, provider-registry, configuration, MCP, or
release-facing changes when practical. Report any check not run and why.

Never run `vp run test:live`, enable `RUN_LIVE_TESTS`, start the daemon, or use
real provider endpoints unless the user explicitly requests live validation
and supplies the required safe environment.

## Code conventions

- Use strict TypeScript and native ESM. Relative TypeScript imports must use
  `.js` extensions.
- Match the formatter: two spaces, single quotes, semicolons, and LF endings.
- Preserve `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and the
  other strict compiler guarantees; do not weaken checks to land a change.
- Prefer Zod validation at untrusted/configuration boundaries and inferred
  types from schemas where the project already follows that pattern.
- Provider validation or expected API failures should return `fail(...)`
  rather than throw, allowing the updater loop to continue.
- Use `ok(...)` and `skipped(...)` consistently for provider results.
- Reuse shared behavior in `lib/providers/http.ts`, `lib/safe-https.ts`,
  `lib/url-policy.ts`, and `lib/sensitive.ts`; do not bypass pinning, URL
  policy, redaction, or request metadata.
- Keep public behavior covered by colocated `tests/*.test.ts` or
  `tests/providers/*.test.ts`. Prefer observable behavior over implementation
  details.
- Provider HTTP tests must use `stubFetch`/existing provider helpers so tests
  remain deterministic and make no live network calls.

## Security and operational safety

- Never print, commit, infer, or embed real credentials. Use obvious fake
  values in tests and documentation.
- Preserve secret redaction for tokens, passwords, authorization headers,
  usernames, OAuth identifiers, URLs, errors, and response previews.
- Do not relax HTTPS-only, DNS-rebinding, private/loopback/metadata address, or
  hostname allowlist protections without explicit user direction and focused
  security tests.
- Configuration must be validated before network requests.
- For MCP-driven DNS operations, validate configuration and dry-run first.
  Explain affected hosts, require explicit confirmation for live writes, and
  prefer an explicit host list over account-wide updates.
- Respect disabled hosts and persisted state. Do not silently force updates,
  broaden host scope, or delete state files.
- Diagnose failed cycles from history/log data before retrying a live update.

## Configuration and documentation contracts

Configuration, docs, and tests intentionally cross-check one another.

- When adding or changing an environment variable, update its schema/default,
  `.env.example`, relevant docs, and tests.
- When changing provider IDs, defaults, MCP surfaces, security allowlists,
  commands, or README links, expect `tests/docs.test.ts` to require matching
  documentation changes.
- Keep `README.md` concise; put detailed operational guidance in `docs/`.
- Do not add runtime dependencies casually; Fallow rejects unused files,
  exports, and dependencies.

## Adding or changing a provider

Use `vp run scaffold:provider -- <id> "Provider Label"` for a new provider,
then complete every integration point:

1. Implement `lib/providers/<id>.ts` as a `Provider`.
2. Register it in `lib/providers/index.ts` and `PROVIDER_IDS`.
3. Add configuration schema/environment mapping.
4. Add deterministic tests under `tests/providers/`.
5. Update `.env.example` and `docs/providers.md`.

Cover missing credentials, malformed or unsuccessful API responses,
already-current records, IPv4/IPv6 behavior, secret-safe errors, and the
provider's exact request method, URL, headers, and body where applicable.
