# Agent guidance

[Documentation](docs/README.md) maps architecture, deployment, state, and document ownership.

Read [.specify/memory/constitution.md](.specify/memory/constitution.md), [docs/development.md](docs/development.md), and
[docs/security.md](docs/security.md). Prefer package scripts using the pinned Node, pnpm, and
Vite+ toolchain.

- This service crosses network, credential, DNS-write, and host-selection trust
  boundaries. Never print or embed real secrets; preserve redaction, HTTPS-only
  policy, DNS-rebinding protections, allowlists, and request metadata.
- Validate configuration before requests. Expected provider failures return
  the established result type rather than terminating the updater loop.
- Provider tests use `stubFetch` and existing fixtures; never contact live
  providers. Do not run live tests, start the daemon, or perform DNS writes
  without explicit authorization. For MCP writes, validate and dry-run first,
  show exact hosts, and require confirmation.
- Preserve disabled-host and persisted-state behavior. Do not broaden update
  scope, force retries, or delete state while diagnosing.
- Keep strict TypeScript/ESM guarantees and `.js` relative import suffixes.
  Reuse the shared HTTP, URL-policy, safe-HTTPS, and sensitive-data modules.
- Configuration and docs are cross-checked: update schemas/defaults,
  `.env.example`, relevant docs, and tests together. Do not edit `dist/` or
  `coverage/`.
- Run a focused `vp test`, then `vp check`; use `vp run verify` for provider,
  configuration, MCP, registry, or release-facing changes. Report checks not
  run and why.

## Planning and evidence

Use the [project guide](.specify/memory/project-guide.md) and
[constitution](.specify/memory/constitution.md) for substantial changes. The guide
owns Spec Kit scope, retained history, retrospective requirements, and acceptance
evidence. Prose maintenance uses the normal repository workflow.

## Context and handoffs

- Search before reading. Use bounded source excerpts for exploratory reads over
  350 lines, and inspect required guidance and actual source before editing.
- When delegation is permitted, assign a bounded question or output, paths, and
  check. Return source locations, changes, and verification gaps for final review.
- Keep durable corrections in the [project guide](.specify/memory/project-guide.md)
  or owning contract. Replace superseded advice and read it before reuse.
  Temporary progress belongs in task notes. Preserve existing authority rules.
