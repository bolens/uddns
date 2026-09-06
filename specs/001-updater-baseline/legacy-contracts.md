# Legacy capability contracts

Retrospective audit of `cad0c10b2c5b`, 2026-09-06. These requirements extend
[spec.md](spec.md) across the existing CLI, all 15 provider adapters, updater,
control planes, persistence, notifications, and project support surfaces.
[Legacy coverage](legacy-coverage.md) maps each surface to source and checks.

## Contract authority

[README](../../README.md), the complete [.env example](../../.env.example),
[YAML example](../../examples/uddns.multi.yaml), and the linked topic documents are
incorporated into this specification. Their options, defaults, schema fields,
provider credentials, and limits remain normative. Generated registry lists and
CLI help should stay single-sourced rather than be copied into new specifications.
The audit does not turn mocked provider responses into proof of live service
availability or authorize real DNS changes.

## Commands, configuration, and sessions

- **LC-001, CLI:** `start`, `mcp`, `once`, `check-config`, `init`, and `help`
  retain their documented arguments. No arguments display help; legacy flags
  without a command retain daemon compatibility. `check-config` validates and
  reports configuration without a DNS update. `once` processes primary accounts,
  waits for notifications, and returns failure for error, partial, or no-IP cycles.
  `init` generates a private environment template, refuses existing files without
  `--force`, and obeys FR-007 even with force. It does not fabricate credentials.
- **LC-002, configuration:** Environment and versioned YAML configuration retain
  strict field/provider validation, unique account IDs and state paths, enabled
  host selection, and failover graph validation. Account IDs follow the existing
  1–63 character schema. Intervals default to 900000 ms and stay between 60000
  and 86400000 ms. Invalid numeric values must not create a running session.
  Configuration inspection must redact credentials; it is not a reachability test.
- **LC-003, IP policy:** Discovery retains vetted HTTPS endpoints, optional DNS
  fallback (disabled by default), and public-address validation. `dual`, `v4`,
  and `v6` policies apply before deciding whether a host needs updating. Missing
  families default to `keep`; `clear` omits that family from the desired update,
  rather than issuing a DNS-record deletion. Dry runs can discover IPs but must
  neither call provider update methods nor advance saved host checkpoints.
- **LC-004, updater lifecycle:** A session guards overlapping cycles, schedules
  its next interval, and supports interval changes, stop, and restart. Stop must
  interrupt retry delays and await active work before shutdown completes.
  Host results retain updated/unchanged/failed distinctions and partial outcomes.
  Successful host checkpoints must survive a different host's failure; failed
  hosts must remain eligible for retry. Forced updates bypass unchanged checks.
- **LC-005, retry and failover:** Retry defaults remain three attempts with
  1000 ms base and 30000 ms maximum delay. Transport failures, HTTP 429, and
  server errors can retry; ordinary credential errors do not become transient.
  Retry-After is bounded by the configured maximum. After exhaustion, ordered
  standby accounts may handle only their configured overlapping hosts, including
  when a primary failure was non-retryable. Standbys do not independently run
  daemon loops. Successful failover updates the primary host checkpoint.

## Provider acceptance

Every adapter retains the credential and hostname rules in
[providers](../../docs/providers.md), uses the shared HTTP policy, reports failed
lookups instead of blindly creating records, and combines A/AAAA outcomes without
hiding partial failure. The following differences are deliberate contracts:

| ID             | Required behavior and limits                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare`   | Bearer token, resolved or pinned zone, and in-zone hostname checks; a stale record ID must not rename another host. Compare address, proxy mode, and available TTL before skipping. PATCH an existing record; create only when configured.                        |
| `duckdns`      | Strip the DuckDNS suffix for the domains query, pass token and available v4/v6 values, and require both HTTP success and an `OK` response.                                                                                                                        |
| `noip`         | Basic-auth NIC update, documented host/IP query parameters, and NIC response-code classification.                                                                                                                                                                 |
| `dynu`         | NIC update with configured password/token fallback and IPv6 parameter; preserve NIC failure semantics.                                                                                                                                                            |
| `dyndns`       | NIC update with the configured, explicitly allowlisted HTTPS endpoint; custom endpoints do not bypass destination or redirect checks.                                                                                                                             |
| `namecheap`    | DDNS password and domain/host split; IPv4 only. XML `ErrCount` must indicate success; an HTTP 200 alone is insufficient.                                                                                                                                          |
| `route53`      | SigV4-signed requests, verified hosted-zone membership, and XML escaping. Compare the single address and available TTL, use UPSERT, and respect create-if-missing. An RRset with multiple values is replaced by the selected single address.                      |
| `porkbun`      | Key/secret JSON authentication. Explicit domain prevents cross-domain updates; automatic apex inference is limited and is not a public-suffix database. Edit by name/type, including multiple matching records; skip only when all values already match.          |
| `hetzner`      | Auth token, resolved zone identity, and in-zone host split. Paginate record lookup up to the existing 50-page limit, select the first matching name/type, skip an equal address, PUT existing or POST new.                                                        |
| `digitalocean` | Bearer authentication, explicit or bounded inferred domain, and normalized apex/relative/FQDN matching. Reject duplicate matches; skip equal data, PUT existing or POST new.                                                                                      |
| `gandi`        | Bearer authentication and explicit domain membership. GET the RRset, treat 404 as missing, and PUT the desired value; skip only a single equal value with matching TTL.                                                                                           |
| `linode`       | Bearer authentication and domain-ID/name agreement; match record type/name, compare target and TTL, then PUT existing or POST new.                                                                                                                                |
| `ovh`          | Server-time request signing with application and consumer credentials, explicit zone membership, and duplicate-record rejection. PUT or POST as appropriate, refresh the zone after writes, and report refresh failure. Unchanged records do not trigger refresh. |
| `bunny`        | AccessKey authentication, zone/domain agreement, and Type 0/1 mapping for A/AAAA. Compare value and TTL; POST updates or PUT creates.                                                                                                                             |
| `contabo`      | OAuth password-grant credentials and request IDs; explicit zone membership, scoped record lookup, and duplicate-match rejection. Normalize apex forms without treating them as subdomains. Compare data and TTL; PATCH updates or POST creates.                   |

Provider APIs differ in duplicate-record handling and TTL support; no universal
single-record selection or TTL-update behavior is promised beyond this table.
Provider scaffolding must reject invalid/duplicate IDs and preserve the registry,
configuration, documentation, and fixture work required by the generated scaffold.

## State, outbound requests, and reporting

- **LC-006, persistence:** Versioned state stores provider identity and host IP
  checkpoints, not credentials. Missing/invalid state yields a warning and an
  empty checkpoint; a provider mismatch is ignored without deleting the file.
  Writes use atomic durable publication and configured data-root restrictions.
  A state-save failure is warned about and does not undo a successful provider
  write; in-memory state may remain ahead of disk. Empty state paths disable
  persistence. History is schema-validated, redacted, and bounded (default 50).
  It records changed, partial, error, dry-run, skipped-no-IP, and forced cycles,
  without filling the journal with ordinary unchanged cycles.
- **LC-007, outbound safety:** HTTPS connects to the vetted resolved address,
  preserving hostname/TLS checks and resisting DNS rebinding. Provider requests
  default to refusing redirects, carry bounded timeouts, and redact credentials
  from errors and body previews. Loopback and metadata addresses remain blocked.
  Webhook and ntfy destinations may use private LAN hosts under their distinct
  policy; Slack/Discord and discovery do not inherit that exception. See
  [security](../../docs/security.md).
- **LC-008, notifications and telemetry:** Configured change/error filters select
  updated or error/partial cycles. Webhook JSON, ntfy text, Slack text, and Discord
  content retain redaction and destination policy. Notification exceptions warn
  rather than reverse a DNS result; shutdown/one-shot execution awaits queued
  notifications. OpenTelemetry API calls remain optional when no SDK is installed;
  spans end on success and failure and soft-failed operations report error status.
  Logging levels, human/JSON output, and sensitive-value redaction remain shared.

## MCP and HTTP acceptance

- **LC-009, MCP tools:** The 16 registered tools are `list_providers`,
  `list_accounts`, `get_public_ip`, `get_config`, `check_once`, `force_update`,
  `dry_run`, `update_hosts`, `get_status`, `get_history`, `validate_config`,
  `explain_last_cycle`, `set_interval`, `start_loop`, `stop_loop`, and
  `init_config`. Their schemas, account selection, host subsets, and result shapes
  follow [MCP](../../docs/mcp.md). Live check/update/start operations require
  explicit confirmation. Host selection cannot enable a disabled host or introduce
  an unconfigured host. Omitted account selection for start/stop/interval applies
  to all accounts; single-account operations retain their first-account default.
  `init_config` returns templates without writing files and distinguishes rejected
  input from unsupported elicitation as required by FR-007.
- **LC-010, MCP resources and transport:** Preserve `setup_provider`,
  `diagnose_update`, and `fix_config` prompts, and `uddns://config`,
  `uddns://public-ip`, `uddns://status`, and `uddns://history` resources.
  Stdio begins with loops stopped; HTTP starts configured primary loops.
  Streamable HTTP defaults to loopback port 3923. `/mcp`, `/metrics`, and `/events`
  enforce authentication; `/healthz` and `/readyz` remain public. Session/SSE
  capacity and idle eviction retain their bounds (100 sessions, 100 SSE clients,
  30-minute session idle timeout). Invalid sessions must not gain another client's
  state. Transport shutdown closes sessions and updater resources.
- **LC-011, side server:** The optional daemon health server defaults to port
  3924 and retains its separate settings. Both HTTP surfaces require token policy;
  insecure loopback is an explicit opt-in and non-loopback binding requires TLS
  and authentication. Readiness requires a nonempty set of accounts, all running,
  not stopping, with a successful cycle and no last error. Liveness alone does
  not establish DNS readiness. Metrics and bounded SSE subscriptions expose
  redacted runtime state, not credentials.

## Delivery and supporting surfaces

- **LC-012, packaging and deployment:** Node/TypeScript CLI builds, locked package
  manager/runtime pins, Compose examples, read-only/non-root image behavior,
  persistent paths, graceful stop, and health deployment options follow
  [deployment](../../docs/deployment.md). Builds and dry-run fixtures do not
  validate live credentials. [RELEASING](../../RELEASING.md) owns tagged image,
  SBOM, attestation, signing, alias, and Pages publication gates; a source retrofit
  does not itself create a version release.
- **LC-013, site and maintenance:** Static documentation, provider/architecture
  data, navigation, canonical/sitemap/robots assets, responsive layout, and theme
  controls remain part of the repository. Theme precedence is valid query value,
  saved preference, then system; time mode uses local 07:00–19:00 light hours.
  Storage denial must not break rendering. The site does not operate the updater.
  Documentation/registry checks, provider scaffolding, parallel test runner,
  dependency-pin checks, hooks, CI, and Spec Kit templates support the contracts
  in [development](../../docs/development.md), rather than create runtime features.

New capabilities require a prospective change specification. Existing contract
changes must update this mapping and their native acceptance checks together.
