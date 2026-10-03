# Plugin maintenance documentation

These documents guide agents and maintainers working on the public plugin. End-user installation and usage instructions are in the [Korean user README](../README.md).

- [Development and validation](development.md): Dev Container setup, builds, tests, and distribution files
- [Remote MCP transport contract](remote-mcp.md): endpoints, OAuth scopes, request ordering, result envelopes, and bounded failures
- [Plugin runtime and configuration](runtime.md): components, tool calls, account connections, and local settings

Document only client behavior verifiable in this repository and public API contracts. Do not record private EncBird service source code, storage structures, operational infrastructure, or internal validation procedures here. The `docs/` directory is publicly accessible.
