# Agent guidance

Before Spec Kit planning or implementation, read
`.specify/memory/project-guide.md` with the project constitution. It maps
requirements to this repository's source, acceptance evidence, and validation.

Read `.specify/memory/constitution.md`, `docs/development.md`, and
`docs/security.md`. Prefer package scripts using the pinned Node, pnpm, and
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

## Spec-driven changes

Use Spec Kit for new capabilities, architecture, security-sensitive behavior,
migrations, and coordinated multi-file changes. Keep narrow fixes, dependency
updates, prose edits, and release housekeeping in the normal repository
workflow unless their risk warrants a written specification. Keep completed
feature directories under `specs/` as decision history; do not backfill them for
finished work.

## Context and handoffs

- Locate source with targeted searches before reading. For exploratory reads of
  files over 350 lines, select relevant ranges. Read required guidance and actual
  source before edits or correctness claims; summaries do not replace them.
- When delegation is permitted, give each worker one question or concrete output,
  allowed paths, and a check. Return findings with source locations, changed paths,
  and verification gaps. Keep final review with the coordinating agent.
- Record durable user corrections in the [project guide](.specify/memory/project-guide.md)
  or owning contract with scope, reason, and evidence. Replace superseded advice;
  read relevant corrections before reusing assumptions. Keep temporary progress
  in task notes and preserve existing authority rules.
