# State and recovery

[Documentation](README.md) · [Deployment](deployment.md) ·
[Security](security.md) · [MCP](mcp.md)

uDDNS persists JSON checkpoints rather than using a database server. Keep provider
configuration, credentials, successful host checkpoints, and diagnostic history
separate during recovery.

## Checkpoint contract

[The state schema](../lib/schemas/state.ts) owns the format version, provider
identity, and host-to-public-IP mapping. [The state store](../lib/state.ts) validates
loaded JSON and uses [durable replacement](../lib/atomic-file.ts) when saving.
Credentials and raw provider responses do not belong in checkpoints.

A provider mismatch causes the stored checkpoints to be ignored without deleting
the file. It is not a schema migration. Do not rewrite provider identity or remove
state merely to bypass validation. Use [state tests](../tests/state.test.ts) for
missing, malformed, and incompatible input behavior.

## Operational recovery

[Deployment](deployment.md) owns checkpoint location and container persistence.
Preserve the configured data volume when replacing an image. Restoring an older
image does not restore its checkpoint contents or undo DNS changes at a provider.

Before a state-format change, define compatibility with existing files and the
rollback path. Use isolated files and stubbed providers to test the transition.
For operational recovery, preserve a consistent copy of state before replacement
and keep credentials in their existing secret source. Review host selection and
use the documented validation and dry-run path before resuming DNS writes.

Checkpoint IPs are bookkeeping, not proof of current provider records. History
has its own [schema](../lib/schemas/history.ts) and privacy constraints in the
[security guide](security.md). Do not use raw history as a public diagnostic
attachment or merge histories into checkpoint state.
