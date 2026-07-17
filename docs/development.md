# Development

## Commands

```bash
vp check              # formatting + type-aware lint + types
vp fmt --write        # format in place
vp lint               # oxlint
vp test               # deterministic unit + docs-contract tests
vp run test:live      # opt-in Dyn test-account HTTP check
vp staged             # run checks on staged files
vp config             # install Vite+ git hooks
vp run docs:check     # focused documentation-drift checks
vp run lean:check     # Fallow dead-code/dependency check
vp run build          # emit dist/
vp run start          # core updater daemon
vp run mcp            # optional stdio MCP server
vp run mcp:http       # optional Streamable HTTP MCP server
vp run config:check   # validate .env after building
vp run verify         # check + parallel tests + build + dead code
```

Set `VITE_GIT_HOOKS=0` when hooks should not be installed.

Provider HTTP suites mock `fetch`, so `vp test` and CI are deterministic. Dyn
is the only bundled provider with a public client-development test account.
Other providers remain mocked.

## Architecture

```text
app.ts                 # core updater daemon entry
mcp.ts                 # optional stdio/HTTP MCP entry
lib/
  config.ts            # re-exports loadConfig
  defaults.ts          # scalar runtime defaults
  hosts.ts             # multi-host parse/bind helpers
  ip.ts                # DNS + HTTPS public IP discovery
  log.ts               # timestamped, redacting logger
  state.ts             # atomic per-host checkpoints
  updater.ts           # reusable check/update session
  mcp/                 # optional MCP server, tools, resources, HTTP auth/TLS
  schemas/             # Zod schemas + inferred types
  providers/
    index.ts           # provider registry
    http.ts            # fetch helpers + HttpError
    nic-update.ts      # shared DynDNS /nic/update client
    cloudflare.ts      # Cloudflare API provider
    ...
tests/
  helpers/             # shared fixtures
  *.test.ts            # core, entrypoint, MCP, and docs contracts
  providers/           # provider and shared-layer suites
  live/                # explicitly enabled live checks
```

## Keeping code and docs synchronized

- `.env.example` is the complete environment-variable reference.
- `README.md` is the short entry point; detailed guides live in `docs/`.
- Documentation tests lock provider IDs, defaults, MCP surfaces, package
  commands, README links, and CI test coverage to their source definitions.
- Fallow rejects unused files, exports, and dependencies.
- Run `vp run verify` before committing.

## Adding a provider

1. Create `lib/providers/<id>.ts` exporting a `Provider` (`id`, `label`,
   `update`).
2. Register it in `lib/providers/index.ts` and `PROVIDER_IDS` in
   `lib/schemas/provider.ts`.
3. Map environment variables in `lib/schemas/config.ts`.
4. Add `tests/providers/<id>.test.ts` and a live suite only when the provider
   publishes a real test endpoint.
5. Update `docs/providers.md` and `.env.example`.

Return `fail("...")` for provider validation errors instead of throwing, so the
loop keeps running.
