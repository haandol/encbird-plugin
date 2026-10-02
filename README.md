# EncBird plugin

An independent EncBird skill and local Model Context Protocol (MCP) server for Codex and Claude Code. The Node runtime is bundled into `plugins/encbird/dist/index.js`; an installed copy needs Node, not Go, a package installation, or the EncBird application repository. All inference is provided by the host assistant.

Source and bundled releases: <https://github.com/haandol/encbird-plugin>. This public repository contains the plugin, its tests, and a pinned API contract. The EncBird application and backend remain separate. The production MCP learning API and its Cognito OAuth client have not been deployed yet; use the local integration environment until that rollout is complete.

**Integration status:** all 15 learning tools are enabled with canonical input/output schemas, alongside connect/disconnect. `contracts/openapi.json` is the pinned OpenAPI 3.1 contract; `tools.json` is derived from native request bodies, parameters, and response schemas. The installed runtime validates inputs and outputs. Verification uses mock HTTP and synthetic samples serialized through the actual backend Go DTOs. No real Cognito sign-in or production API request was performed during development.

## Build and verification

From this directory:

```sh
npm ci --ignore-scripts
npm run check
```

`check` runs TypeScript checking, a bundled build, mock-only tests, and manifest/contract/hash validation. The build includes third-party license notices and a manifest containing bundle and contract SHA-256 hashes. Source changes require rebuilding before distribution; `validate` detects a modified contract or bundle that disagrees with the build manifest.

The mock suite covers PKCE, state, signed ID-token validation and nonce rejection, callback contention, refresh rotation, revocation retries, owner-only credentials, cross-process locking, fixed API routes, response/error handling, no redirects or automatic fallback, secret redaction, and a spawned stdio MCP process. All fifteen learning tools are also exercised in a spawned MCP process against mock HTTP.

## Host loading

| Host/package path | Server definition | Launch argument |
| --- | --- | --- |
| Portable Agent Plugins / current Codex | `plugins/encbird/plugin.json` and `mcp.json` | `${PLUGIN_ROOT}/dist/index.js` |
| Codex compatibility manifest | `.codex-plugin/plugin.json`, inline `mcpServers.encbird` | `${PLUGIN_ROOT}/dist/index.js` |
| Claude Code | `.claude-plugin/plugin.json` and `.mcp.json` | `${CLAUDE_PLUGIN_ROOT}/dist/index.js` |

Every server definition uses `command: "node"` and stdio transport. `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT` are host substitutions, not variables the learner must set. No shell expansion is required. Portable components are canonical in current Codex; the OpenAI inline extension contains presentation metadata, and the Codex fallback is for older loaders. Hosts should resolve one named `encbird` server, not start each companion definition independently.

The repo-local Codex catalog is `.agents/plugins/marketplace.json`; the Claude Code catalog is `.claude-plugin/marketplace.json`. Both point to `./plugins/encbird`. Install the skill and local MCP together from this repository:

```sh
# Codex
codex plugin marketplace add haandol/encbird-plugin
codex plugin add encbird@encbird

# Claude Code
claude plugin marketplace add haandol/encbird-plugin
claude plugin install encbird@encbird
```

Start a new host session after installing. These commands install the plugin package; browser sign-in also needs the learning API and OAuth client to be running. For development from a local checkout, Codex accepts its absolute repository path in `marketplace add`. Claude Code can load the plugin for one isolated session:

```sh
claude --plugin-dir /absolute/path/to/encbird-plugin/plugins/encbird
```

If a host version cannot load local plugins or expand the root variable, its ordinary stdio MCP configuration can use this concrete fallback:

```json
{
  "mcpServers": {
    "encbird": {
      "command": "node",
      "args": ["/absolute/path/to/encbird-plugin/plugins/encbird/dist/index.js"]
    }
  }
}
```

For Codex's ordinary MCP configuration, the equivalent is:

```toml
[mcp_servers.encbird]
command = "node"
args = ["/absolute/path/to/encbird-plugin/plugins/encbird/dist/index.js"]
```

Replace the absolute path when moving the package. These are examples only; no settings were changed. Loading only the MCP fallback does not install the skill. Load `plugins/encbird/skills/encbird-learning` through the host's supported skill mechanism as well.

OpenAI's current public submission documentation requires a remote HTTPS MCP endpoint or separate support for a local MCP. This local stdio package is not a claim of universal-directory acceptance. Browser sign-in and the callback run on the same desktop machine as this process; remote/headless hosts and Windows are not currently supported. The POSIX credential protection implementation supports macOS and Linux; tests ran on macOS with Node 24.13.0, and the declared runtime baseline is Node 22.12.0.

## Runtime configuration and credentials

| Variable | Behavior |
| --- | --- |
| `ENCBIRD_API_BASE_URL` | Unset uses `https://api.encbird.com/v1/mcp-learning`. An explicitly set value must be loopback HTTP (`localhost`, `127.0.0.1`, or `[::1]`), with the desired API prefix. Credentials, query, and fragment in the URL are rejected. HTTPS overrides are rejected. No fallback occurs. |
| `ENCBIRD_CREDENTIALS_DIR` | Optional canonical absolute directory. Defaults to `~/.encbird-plugin`. Must be owner-only and owned by the current user. Symlinked paths are rejected. Installed plugin folders are never used for credentials. |
| `ENCBIRD_AUTH_SCOPE` | Optional stable local host/profile label. Otherwise the MCP initialize `clientInfo.name` is used. Scope is hashed with the API base and machine hostname. A host with no name uses `unknown-mcp-client`; use separate explicit labels if multiple hosts report the same name. |

No API key, access token, refresh token, or client secret is accepted as configuration. Directory mode is `0700`; credential files are `0600`. This is a private filesystem store, not OS-keychain encryption. A cross-process lock spans refresh, atomic writes, and API operations. Busy callers receive a retryable error; a lock heartbeat prevents takeover during a browser sign-in, and a crashed process's lock becomes reclaimable after 30 seconds. Use local disks: network filesystem lock guarantees are not asserted.

Connect opens the browser, returns `authentication_pending`, and completes asynchronously. Call connect after browser sign-in to get `connected`. A second sign-in cannot steal callback port 18765. The listener binds only IPv4/IPv6 loopback, checks the exact Host/path, state, and callback parameters, and times out after three minutes. Closing the MCP process cancels the browser wait.

Bootstrap uses the exact configured `/config` URL without redirects. That trusted response supplies the public client and OAuth endpoints. Endpoints require HTTPS in production; explicit local development permits HTTP only on the bootstrap origin. Authorization, token, and revocation endpoints must share one origin. OIDC discovery must agree with the issuer/authorization/token endpoints, and its JWKS endpoint must share the issuer origin. `jose` verifies RS256 signature, issuer, audience, expiry, subject, `token_use: id`, and initial nonce. No JWT is merely decoded and trusted.

Disconnect disables credentials before network cleanup, deletes the backend connection, revokes the refresh token, then removes the credential record when both operations succeed. Failed cleanup retains private revocation records and blocks learning calls. If refresh returns `invalid_grant`, connect starts same-account browser recovery rather than abandoning the previous grant. `disconnect` retries independently completed stages. Provider revocation waits for confirmed backend deletion. A backend failure retains refresh capability for cleanup only; provider failure retains only the refresh token after the backend is revoked. Learning access stays disabled throughout retries. During recovery the client journals fresh tokens and nonce before identity verification, checks the previous owner, uses a currently valid bearer with each previous `connectionId` at `/connection/revoke-previous`, confirms all older backend revocations before closing their provider tokens, and only then registers the new family. Recovery authorization includes Cognito `prompt=login` for explicit reauthentication without global SSO logout. Historical access tokens are never sent to the API. A stored connection ID is used directly; only a missing ID is derived from the private old token origin_jti and stored client ID as SHA256(JSON([clientId, origin_jti])). Decoded old claims supply no authentication or owner identity. Fresh ID-token subject must match the persisted previous owner, and the server acts only in that fresh subject’s user partition. Pending grants and verified/unverified recovery stages survive process restart; cancellation or a different account cannot replace the owner. Transient provider failures retain refresh capability for retries.

## Contract verification and integration

The backend remains owned separately. The public plugin validates only its pinned OpenAPI, generated snapshot, bundle hashes, and copied synthetic serialization samples. `npm run check` needs no private source access. The canonical private workflow generates POST inputs from `requestBody.content.application/json.schema`, GET inputs from `parameters`, and outputs from native response schemas. There is no duplicate custom input schema.

The private owner runs `python3 scripts/mcp/contract_verify.py` to check current Go DTO fingerprints, deterministic generation, drift rejection, and exact Go JSON serialization. Its optional `--plugin-root` checks these public copies too. Backend and public snapshots share `openapiSha256`; changing a Go DTO or native OpenAPI without updating the reviewed contract fails the corresponding check.

Production Cognito sign-in and deployed API behavior still require deployment verification. The public-client scopes are the configured resource followed by `/learning.read` and `/learning.write`, plus `openid`. Initial ID tokens require nonce verification; refreshed identity tokens verify signature/issuer/audience/subject without requiring the initial nonce.

`CONNECTION_INACTIVE` 403 disables and cleans up the local family and requires a new browser sign-in. Other server error codes retain their code and a safe local message. The runtime rejects unexpected output fields, malformed result shapes, credential strings, and detectable sensitive external-learning inputs. Every result includes identical JSON as text and `structuredContent`. `encbird_accept_suggested_expression` acknowledges an already registered NORMAL vocabulary entry using the original candidate hash/version and registration key. It requires write permission but never charges, generates content, or replaces the existing registration approval flow. Expression candidates require `phraseOrigin` (`user_expression`, `quoted_expression`, or `host_generated`). The first two must occur in cited actual user messages; read results may omit the field for legacy rows. The host skill preserves this distinction rather than presenting generated wording as learner usage.

## Sources checked

- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins): portable layout, compatibility overlay, repo catalogs, and local-MCP publication limits.
- [Agent Plugins manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json) and [MCP schema](https://agent-plugins.org/schemas/1.0.0/mcp.schema.json): vendored validation inputs under `docs/evidence`.
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference): manifest, `.mcp.json`, and `${CLAUDE_PLUGIN_ROOT}` argument substitution.

Checked on 2026-10-02. These sources establish formats; a schema-valid package alone does not establish host installation or public availability.

## License

A license for the plugin source has not been selected. Bundled dependencies retain their own licenses in `plugins/encbird/dist/THIRD_PARTY_LICENSES.txt`.
