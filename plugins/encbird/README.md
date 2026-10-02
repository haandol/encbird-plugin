# EncBird

This package bundles the EncBird learning skill and a Node stdio MCP server. Run `node dist/index.js` with Node 22.12 or newer on macOS/Linux. Dependencies are included in the bundle; no install or private application checkout is required.

Codex uses portable `plugin.json` and `mcp.json` (`${PLUGIN_ROOT}`); older Codex loaders have `.codex-plugin/plugin.json`. Claude Code uses `.claude-plugin/plugin.json` and `.mcp.json` (`${CLAUDE_PLUGIN_ROOT}`). Browser OAuth requires a local desktop and loopback port 18765. Credentials live outside the plugin in a private per-host store.

This build exposes 15 learning tools plus connect/disconnect. Input/output schemas and routes are generated from pinned OpenAPI 3.1 and validated at runtime; no learning save is simulated. The host supplies all model inference. Source: <https://github.com/haandol/encbird-plugin>. The production learning API and OAuth client still need deployment; this release can be exercised against the local integration environment.

Runtime variables: `ENCBIRD_API_BASE_URL` accepts an explicit loopback HTTP development endpoint only; unset uses `https://api.encbird.com/v1/mcp-learning`. `ENCBIRD_CREDENTIALS_DIR` overrides the private local storage directory. `ENCBIRD_AUTH_SCOPE` distinguishes host profiles if their MCP client names coincide. Never paste tokens into the assistant.

Connect returns pending while the browser flow runs; call it again after sign-in. Disconnect disables local access and attempts both backend and provider revocation. If cleanup remains pending, retry disconnect. If refresh is no longer usable, connect performs browser recovery for the same account while retaining the previous private grant record and connection ID; never delete pending credential records or paste tokens into the assistant. All pending older backend families are revoked before any of their provider tokens are closed. Recovery uses Cognito prompt=login without global SSO logout. Backend failure retains refresh capability for cleanup only; provider failure retains the refresh token for retry. Do not treat a pending cleanup as fully revoked.

Maintainer setup and the integration checklist are in the repository-root README. Third-party bundled licenses are in `dist/THIRD_PARTY_LICENSES.txt`. The plugin's own source license has not yet been selected.
