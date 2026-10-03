# Development and validation

This repository contains everything needed to modify and test the plugin. Tests use mock OAuth, lifecycle HTTP and remote MCP responses; they do not verify real account sign-in or production service behavior.

## Development environment

Install Docker and the VS Code Dev Containers extension, open the repository, and run **Dev Containers: Reopen in Container**. The [Dockerfile](../.devcontainer/Dockerfile) installs Node 24, Git, GitHub CLI, and development tools. The [container configuration](../.devcontainer/devcontainer.json) runs `npm ci --ignore-scripts` when the container is first created.

Source files are shared with the host. Each container uses separate volumes for `node_modules` and `.test-tmp`. Closing the VS Code window stops the container.

Use the Dev Container for builds and mock API tests. Run real browser sign-in on a supported desktop environment. Inside the container, `localhost` refers to the container itself; the current configuration does not connect login callbacks from the host browser.

## Builds and tests

Run these commands from the repository root in the container terminal. Skip `npm ci` if container creation has already installed the dependencies.

```sh
npm ci --ignore-scripts
npm run check
```

The `check` script in the [root package.json](../package.json) runs these steps in order:

| Command | Scope |
| --- | --- |
| `npm run typecheck` | TypeScript type checking |
| `npm run build` | Generate the executable bundle, third-party license notices, and build metadata |
| `npm test` | Test authentication, connection recovery, remote MCP calls, script plans, request controls and credential storage against mocks |
| `npm run validate` | Check plugin configuration, API contracts, serialization samples, and bundle hashes |

Type checking and build commands are defined in the [plugin package.json](../plugins/encbird/package.json). Tests live in [test/](../plugins/encbird/test/); distribution checks are implemented in [validate.mjs](../scripts/validate.mjs).

## Contracts and distribution files

[contracts/openapi.json](../plugins/encbird/contracts/openapi.json) defines HTTP request and response formats in OpenAPI 3.1. [contracts/tools.json](../plugins/encbird/contracts/tools.json) contains the corresponding tool names, input and output schemas, and routes. A schema defines the allowed structure of a payload. These schemas remain the input/output authority for remote MCP tool arguments and results. The [transport contract](remote-mcp.md) defines the `/mcp` envelope and lifecycle separation; remote calls do not use the learning REST route metadata to send requests. [serialization-samples.json](../plugins/encbird/contracts/serialization-samples.json) provides synthetic input and output examples for validation.

`validate` derives each tool's contract from OpenAPI and compares it with `tools.json`. POST inputs come from request bodies, GET inputs from parameters, and outputs from success response schemas. When changing a public contract, update the corresponding copies and samples, then set `openapiSha256` to the SHA-256 hash of the OpenAPI file. A SHA-256 hash identifies changes to file contents.

[build.mjs](../plugins/encbird/scripts/build.mjs) generates:

- `plugins/encbird/dist/index.js`: the executable bundle, including required libraries
- `plugins/encbird/dist/cli.js`: the standalone script runtime, imported by the skill's runner
- `plugins/encbird/dist/build-info.json`: bundle and contract hashes, plus build input metadata
- `plugins/encbird/dist/THIRD_PARTY_LICENSES.txt`: full license texts for bundled third-party libraries

Rebuild and validate after changing runtime source or contracts. `validate` compares recorded bundle and contract hashes, but does not establish whether the bundle was built from the current source. Include the plugin directory's `LICENSE` and `NOTICE` in distribution files.

The MCP and script bundle hashes are both checked. Distribution must include the skill's `scripts/` and `references/` directories. Script tests invoke the installed runner as a separate process against mock HTTP endpoints, including sequential execution, invalid-plan rejection, and persistent cooldowns. Traffic tests also cover concurrent callers, rolling-window admission, MCP negotiation requests, and cooldowns during remote calls. No test sends learning data to the production API.

## Publishing changes

Inspect the diff, including generated files, before committing. New documentation, examples, and contract descriptions should contain only information needed to maintain the public client. Preserve API input and output requirements and error handling without copying private service implementation details.

For local pushes, follow the [Docker push procedure in AGENTS.md](../AGENTS.md). After pushing, verify that the remote branch commit matches local `HEAD`.
