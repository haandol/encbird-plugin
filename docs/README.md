# Plugin maintenance documentation

These documents guide agents and maintainers working on the public plugin. End-user installation and usage instructions are in the [Korean user README](../README.md).

## Build and verify

- [Development and validation](development.md): Dev Container setup, builds, tests, and distribution files
- [Continuous verification](continuous-verification.md): committed-runtime checks, source receipts, CI, and main protection rollout
- [Behavior evaluation](behavior-evaluation.md): synthetic conversations, preserved action evidence, and explicitly selected live evaluation

## Runtime and connections

- [Remote MCP transport contract](remote-mcp.md): endpoints, OAuth scopes, request ordering, result envelopes, and bounded failures
- [Plugin runtime and configuration](runtime.md): components, tool calls, account connections, and local settings

## Decisions and releases

- [Versioned release workflow](releases.md): Docker-only preparation, tag pushes, publication and recovery
- [Architecture decisions](adr/README.md): decision scope, authoring rules, and the registry

Document only client behavior verifiable in this repository and public API contracts. Do not record private EncBird service source code, storage structures, operational infrastructure, or internal validation procedures here. The `docs/` directory is publicly accessible.
