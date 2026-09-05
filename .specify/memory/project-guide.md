# uddns Spec Kit project guide

A TypeScript dynamic-DNS updater with reusable provider logic, CLI/MCP surfaces, and
health/status services.

Read this guide with `AGENTS.md` and `.specify/memory/constitution.md` before
specifying, planning, or implementing a substantial change. It is project-owned
guidance, not an upstream-managed template.

## Source and ownership map

- `lib/schemas/`
- `lib/providers/`
- `lib/updater.ts`
- `lib/runtime.ts`
- `lib/mcp/`
- `docs/security.md`
- `tests/`

## Specification and plan decisions

Specify host selection, disabled hosts, address-family policy, provider results,
persisted state, and retry behavior. Keep provider HTTP and URL safety in shared
modules. Configuration/schema, environment examples, provider registry, docs, and MCP
surfaces form one contract.

## Acceptance evidence

Cover missing or malformed credentials without exposing them, partial provider failure,
disabled hosts, stale state, IPv4/IPv6 policy, dry-run behavior, hostile URLs, and
health/readiness differences. Use stubFetch and existing fixtures, never live providers.

## Validation and operational limits

```sh
pnpm exec vp check
pnpm run verify
```

Use the pinned package/runtime toolchain and focused tests before the full gate. Do not
weaken HTTPS, DNS-rebinding, metadata-address, redaction, or allowlist defenses.
Starting the daemon or performing DNS writes requires explicit operational scope.

## Working through Spec Kit

Use Spec Kit for new capabilities, architectural or security-sensitive changes,
migrations, and coordinated changes that need a written contract. Keep narrow fixes,
dependency updates, and prose maintenance in the normal PR workflow.

For a new feature, record observable acceptance criteria in `spec.md`, source ownership
and constitution checks in `plan.md`, and evidence-bearing work in `tasks.md` under the
feature directory created by Spec Kit. Resolve material unknowns before implementation.
Mark tasks complete only after their stated verification, and distinguish completed,
skipped, blocked, and manual checks. Retain completed feature documents as decision
history; do not backfill feature specifications for already finished code.

Keep `.specify/templates/`, `.specify/scripts/`, and generated Codex skills under their
integration manifests. Use this guide and the constitution for local customization.
Regenerate managed files through Spec Kit and verify that project-owned memory survives
updates. Follow `RELEASING.md` for push, merge, release or delivery, and recovery.
