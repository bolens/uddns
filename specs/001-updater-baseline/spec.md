# Feature specification: Dynamic DNS sessions and restricted control planes

**Created**: 2026-09-05
**Status**: Retrospective baseline
**Inspected revision**: `3d2837fa6a37ad98b0220c661192833e9447f4cb`
**Input**: The owner requested a fleet-wide Spec Kit retrofit and implementation audit.

CLI, daemon, and optional MCP interfaces share provider sessions for multi-account, multi-host dynamic DNS updates.

This specification records existing contracts after implementation. It does not
claim that the original work followed Spec Kit. New behavior requires a separate
change contract. Existing feature specifications remain authoritative within their
own scope.

## User scenarios and testing

### User story 1: Use the documented entry points (P1)

An operator selects a supported command or source workflow.

**Acceptance**: Inputs, output/status, and ownership remain consistent with the source contracts below.

### User story 2: Handle invalid input and partial failure (P2)

A configuration, dependency, subprocess, or persistence operation fails.

**Acceptance**: The named regression fixtures preserve failure reporting and recovery without claiming an unverified successful operation.

### User story 3: Maintain the contract (P3)

A maintainer changes the implementation or adds a supported capability.

**Acceptance**: The source registry, public documentation, tests, and delivery checks change together; operational actions remain separately scoped.

## Requirements

- **FR-001**: CLI, daemon, and MCP MUST share validated configuration, canonical provider IDs, and per-account/per-host update semantics.
- **FR-002**: Dry-run cycles MUST avoid provider writes and checkpoint advancement; concurrent cycles MUST retain the guarded busy/stop contract.
- **FR-003**: Outbound HTTPS MUST connect only to vetted resolved addresses and retain documented redirect and credential boundaries.
- **FR-004**: State and history MUST retain bounded validated schemas, atomic durable publication, configured data-root restrictions, and credential redaction.
- **FR-005**: HTTP control planes MUST require their documented token/TLS policy, with explicit confirmation for live MCP mutation tools.
- **FR-006**: Missing IP families, retry/failover, intervals, and per-host failures MUST retain explicit policy and deterministic reporting.

## Success criteria

- **SC-001**: Every requirement has a named source owner and acceptance check in `coverage.md`.
- **SC-002**: The listed native checks pass for the reviewed candidate, with unavailable environments and operational checks recorded separately.
- **SC-003**: Retrofitting preserves existing interfaces and completed specifications. Any confirmed implementation gap is corrected under an explicit requirement before it is marked complete.

## Edge cases and operational limits

No live DNS records or notification destinations are used as fixtures. Passing local HTTP and mocked provider tests does not prove current external provider availability. Hosted Docker delivery and actual deployment have separate evidence; no version tag is required for this baseline.
