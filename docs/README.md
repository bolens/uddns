# Documentation

Dynamic DNS provider execution, health, MCP, and durable checkpoints.

## Start here

| Need | Owning document |
| --- | --- |
| Use the project | [README.md](../README.md) |
| Change the repository | [AGENTS.md](../AGENTS.md) |
| Deliver or recover | [RELEASING.md](../RELEASING.md) |
| Plan substantial changes | [.specify/memory/project-guide.md](../.specify/memory/project-guide.md) |
| Non-negotiable constraints | [.specify/memory/constitution.md](../.specify/memory/constitution.md) |

## Architecture

[Development](development.md) owns runtime and provider extension boundaries. Configuration is
validated before provider requests, and failures return through the established result contract.
[Security](security.md) owns URL policy, DNS-rebinding defenses, redaction, and host-selection
constraints. CLI, daemon, and MCP share this behavior.

## Deployment and recovery

[Deployment](deployment.md) owns process modes, container mounts, health checks, and operational
configuration. [RELEASING.md](../RELEASING.md) owns artifact publication and verification. Starting
the daemon can write DNS, so validation uses fixtures and stubbed providers.

## Database and state

[State and recovery](state.md) owns JSON checkpoints and history boundaries. This service does not
need a database server. Configuration, secrets, successful per-host checkpoints, and diagnostic
history must remain distinct during migration and recovery.

## Documentation maintenance

Keep decisions, invariants, failure modes, and recovery requirements in the owning document. Link to
commands, defaults, schemas, and generated catalogs instead of copying them. Change the owner and
affected references together. Update this index when adding or moving a guide, and verify relative
links and heading anchors. Historical specs and audits describe their recorded revision, not current
runtime proof. A topic without an implementation stays explicitly unimplemented.

## Topic guides

- [Deployment](deployment.md)
- [Development](development.md)
- [Optional MCP server](mcp.md)
- [Providers and configuration](providers.md)
- [Release playbook](releasing.md)
- [Security](security.md)
- [State and recovery](state.md)

- [Development environments](development-environments.md)
