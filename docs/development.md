# Development

[Documentation](README.md)

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

CLI (after `vp run build`):

```bash
node dist/cli.js start
node dist/cli.js once --force
node dist/cli.js once --dry-run
node dist/cli.js init --defaults
node dist/cli.js check-config
node dist/cli.js mcp --transport=http
```

`init` validates the provider, single-line host field, and runtime interval bounds
before writing `.env`. It leaves credentials for the operator to supply and
refuses existing files unless `--force` is explicit. Run `check-config` after
adding credentials to validate the complete provider configuration.

Set `VP_GIT_HOOKS=0` when hooks should not be installed.

The pnpm catalog keeps Vite+, its Vite core, Vitest, and the coverage provider
compatible. Use the target Vite+ release's migration command when updating this
coupled toolchain, review its migration findings, and verify all deterministic
tests and coverage thresholds before merging.

For an existing Vite+ project, run the target release's `vp help migrate`, then
`vp migrate --no-interactive --no-hooks --no-editor` through that exact release.
This preserves the repository-owned Git hooks and editor settings while updating
the coupled catalog and lockfile. Inspect both the direct Vite alias and the
Vite+ dependency: a bot update to only `vite-plus` can retain two Vite core
versions. Regenerate the lockfile with the pinned pnpm version, review migration
findings and formatting changes, and run `vp run verify` before delivery.

Provider HTTP suites use `stubFetch` (which installs a pin-path transport
override), so `vp test` and CI stay deterministic without live dials. Dyn is
the only bundled provider with a public client-development test account. Other
providers remain mocked.

## Architecture

```text
app.ts                 # core updater daemon entry
mcp.ts                 # optional stdio/HTTP MCP entry
cli.ts                 # unified uddns CLI (bin)
lib/
  config.ts            # re-exports loadConfig
  config-file.ts       # multi-account YAML loader
  defaults.ts          # scalar runtime defaults
  hosts.ts             # multi-host parse/bind helpers
  history.ts           # cycle history ring buffer
  ip.ts                # HTTPS (+ optional DNS) public IP discovery
  ip-policy.ts         # family / missing-family policy
  init.ts              # uddns init wizard
  log.ts               # timestamped/json redacting logger
  notify.ts            # webhook + ntfy + Slack + Discord
  once.ts              # one-shot update
  runtime.ts           # updater + history + notify wiring
  safe-https.ts        # pin-on-connect HTTPS dial
  url-policy.ts        # HTTPS URL + resolved-host safety
  sensitive.ts         # redaction key helpers
  side-server.ts       # health / metrics / SSE
  state.ts             # atomic per-host checkpoints
  updater.ts           # reusable check/update session
  mcp/                 # optional MCP server, tools, resources, HTTP auth/TLS
  schemas/             # Zod schemas + inferred types
  providers/
    index.ts           # provider registry
    http.ts            # request helpers + HttpError (pin by default)
    nic-update.ts      # shared DynDNS /nic/update client
    cloudflare.ts      # Cloudflare API provider
    ...
tests/
  helpers/             # shared fixtures (stubFetch, cleanup)
  *.test.ts            # core, entrypoint, MCP, and docs contracts
  providers/           # provider and shared-layer suites
  live/                # explicitly enabled live checks
```

## Keeping code and docs synchronized

- `.env.example` is the complete environment-variable reference.
- `README.md` is the short entry point; detailed guides live in `docs/`.
- Documentation tests lock provider IDs, defaults, MCP surfaces, package
  commands, README links, security allowlists, and CI test coverage to their
  source definitions.
- Fallow rejects unused files, exports, and dependencies.
- Run `vp run verify` before committing.

## Releasing

See [the release playbook](releasing.md) for versioning, tag publication,
workflow monitoring, and post-release verification.

## Adding a provider

1. Create `lib/providers/<id>.ts` exporting a `Provider` (`id`, `label`,
   `update`).
2. Register it in `lib/providers/index.ts` and `PROVIDER_IDS` in
   `lib/schemas/provider.ts`.
3. Map environment variables in `lib/schemas/config.ts`.
4. Add `tests/providers/<id>.test.ts` and a live suite only when the provider
   publishes a real test endpoint.
5. Update `docs/providers.md` and `.env.example`.

Or scaffold stubs:

```bash
vp run scaffold:provider -- <id> "Provider Label"
```

Return `fail("...")` for provider validation errors instead of throwing, so the
loop keeps running.

For pinned native shells and local Docker, Podman, or Apple container tooling, see
[development environments](development-environments.md).

## Woodpecker CI

| Functional group      | Canonical local command                                                                       | Native workflow                                  |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Validation            | `devenv test` → `bash scripts/check-development.sh`                                           | Legacy `woodpecker` development-environment step |
| Source and unit tests | `pnpm run verify`                                                                             | Legacy `woodpecker` verify step                  |
| Workflow security     | `actionlint` and `zizmor --offline --min-severity medium --min-confidence medium .github`     | Legacy `woodpecker` development-environment step |
| Managed integration   | `bash scripts/ci/check-spec-kit.sh` (included in `bash scripts/ci/check-fleet.sh`)            | Legacy `woodpecker` fleet-contracts step         |
| Site validation       | `python3 scripts/ci/check-site-accessibility.py` and `python3 scripts/ci/check-site-links.py` | Legacy `woodpecker` config-and-site step         |

The legacy workflow and required status names remain stable until a coordinated
fleet migration updates their callers, release dependencies and host settings.
macOS and actual Docker/editor checks remain separate platform coverage.

[`.woodpecker/`](../.woodpecker/) contains the full validation and publishing
profile. Its [`woodpecker.yml`](../.woodpecker/woodpecker.yml) core runs portable
Linux checks on either forge. Gitea copies select the generated
[validation-only profile](../.woodpecker-validation/) and do not publish.

Canonical GitHub-connected Woodpecker publication requires the authenticated
broker policy, `WOODPECKER_PUBLISHING=true`, and the full profile, with retained
GitHub OIDC/Pages bridges. Enable that paired configuration before the genuine
main push that proves cutover. Before disabling publication, drain native and
hosted publishers, select the validation-only profile first, then clear the flag.
Follow [the cutover contract](releasing.md) for the ordered settings and rollback.
The migration contract and remaining acceptance work are recorded in
[`specs/003-woodpecker-publishing/spec.md`](../specs/003-woodpecker-publishing/spec.md).

Existing GitHub Actions gates remain required until the exact-source Woodpecker
checks pass and the owning host settings migrate. Native macOS and GitHub OIDC
signing are retained platform exceptions. Docker build/runtime checks remain on
Actions until equivalent isolated build and fixture execution are proven; runners
do not receive a host Docker socket or broader privileges.

Publication is disabled by default. Activation requires the authenticated server
secret broker's exact GitHub repository/ref/SHA policy and the canonical GitHub
repository variable `WOODPECKER_PUBLISHING=true`. No PR, fork, manual or Gitea
workflow receives publication credentials. Existing release/version rules remain
in [the release playbook](../RELEASING.md).
