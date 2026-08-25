# uDDNS Constitution

## Core Principles

### I. Network and DNS Safety

Configuration MUST be validated before requests. HTTPS-only, DNS-rebinding, private-address, metadata-address, and hostname allowlist protections are mandatory trust boundaries.

### II. Secret-Safe Observability

Tokens, credentials, authorization data, identifiers, URLs, errors, and previews MUST remain redacted in logs, history, MCP responses, and tests.

### III. Explicit Scoped Writes

Live DNS updates, retries, and state changes require explicit scope and authorization. MCP operations validate and dry-run first, identify exact hosts, preserve disabled hosts, and never broaden to account-wide writes silently.

### IV. Deterministic Provider Architecture

Providers use shared HTTP/safety modules and established result types. Tests use fixtures and stubbed fetches; default tests never contact provider endpoints.

### V. Contract Synchronization

Schemas, defaults, `.env.example`, provider registries, docs, MCP surfaces, and tests MUST change together. Strict TypeScript/ESM guarantees remain enabled and generated output is not hand-edited.

## Governance

`docs/security.md` is the detailed security authority. Any protection reduction requires explicit approval, focused negative tests, and a constitution version update.

**Version**: 1.0.0 | **Ratified**: 2026-08-15 | **Last Amended**: 2026-08-15
