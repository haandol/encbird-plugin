# Server access

Use the installed MCP tools or `scripts/encbird.mjs` from this skill. The runner calls the same runtime as MCP, including authentication, input/output validation, privacy filtering, request pacing, and safe errors. Learning calls use the configured remote `/mcp` endpoint; configuration, sign-in and connection cleanup stay in the shared runtime. It does not accept arbitrary URLs or bearer tokens. Keep using the installed tools or runner when the transport changes; do not recreate its login or HTTP flow.

## Connection and credentials

For MCP, `encbird_connect` starts browser sign-in and returns `authentication_pending`. Ask the learner to finish signing in, then call connect once to check for `connected`. Do not repeatedly poll while waiting for the learner. Never request or read a token, callback URL, authorization code, or credential file.

`CONNECTION_INACTIVE` requires a new connection after cleanup. On `OAUTH_INVALID_GRANT` or `reauthenticationRequired`, have the learner sign in to the same account. Cancelled or wrong-account sign-in does not complete recovery. Use the tool's returned next step for incomplete cleanup and report complete revocation only after `disconnected`. Do not delete pending credential records. Recovery does not log the learner out of other applications.

The script uses the fixed client name `encbird-script`, so by default it has a separate sign-in from a host's MCP connection. Sign in once through the script before using its account tools. An explicitly configured, stable `ENCBIRD_AUTH_SCOPE` can share a profile between MCP and scripts; do not guess an existing profile or change it between retries. Authentication scope is not a substitute for actual `sourceHost` or `sourceSessionId` in learning evidence.

## Script commands

Resolve the installed skill's absolute path, then use the `scripts/encbird.mjs` file beside these references. The examples below assume the working directory is this skill's root. They do not require dependency installation.

```sh
node scripts/encbird.mjs list
node scripts/encbird.mjs describe encbird_search_expressions
```

`list` returns names, descriptions, and read-only flags without contacting the service. `describe` returns one tool's complete schema. Use these only when the needed schema is not already available.

For one call, pass exactly one JSON arguments object on standard input. Keep user content out of shell interpolation; use a safely written input file for dynamic text.

```sh
node scripts/encbird.mjs call encbird_connect <<'JSON'
{}
JSON
```

The script opens the browser and stays alive until sign-in completes or times out. A fixed progress message appears on standard error; standard output contains the final JSON result. Do not terminate the script simply because the learner has not finished yet. Cancel it when the learner cancels.

```sh
node scripts/encbird.mjs call encbird_search_expressions <<'JSON'
{"query":"meeting","limit":5}
JSON
```

For a known set of independent reads, `read-plan` accepts 1 to 5 entries and executes them sequentially. The entire plan's tool names and input schemas are checked before any service request. Writes and connection changes are rejected. Do not split an unbounded collection into many plans to bypass the limit.

```sh
node scripts/encbird.mjs read-plan <<'JSON'
[
  {"name":"encbird_get_context","arguments":{}},
  {"name":"encbird_search_expressions","arguments":{"query":"meeting","limit":5}}
]
JSON
```

A plan returns `data.status` as `completed` or `stopped`, with ordered `data.results` containing each tool name and result. It stops at the first error. Inspect the individual results; a stopped plan does not imply later calls ran. Reuse completed results rather than rerunning the whole plan. Input is limited to 1 MiB. Exit code 0 means completion; code 1 means an error or a stopped plan.

Single writes use `call` with the tool's exact schema after satisfying the relevant workflow's approval, evidence, and learner-input requirements. The script neither grants approval nor invents operation keys, source messages, or ratings. Never automate a sequence across an approval or learner-response boundary.

## Request controls and failures

Outgoing learning HTTP requests, including MCP initialization and its acknowledgement notification, are serialized by the authentication profile's cross-process lock, spaced by at least 250 ms, and limited to 60 attempts in a rolling 60-second window. These are local client guardrails, not the service's published quota. A successful tool call normally sends three counted HTTP requests. Attempts count even if they fail or time out. Authentication and revocation have their own finite workflows and are outside this learning-request budget.

Remote MCP HTTP 429 and 503 responses pause further learning requests for `Retry-After`, using either seconds or an HTTP date. If the header is missing or invalid, the client uses 30 seconds. The pause and recent request history are stored with the profile, so starting another script or MCP process in that same profile does not bypass them. The client returns `retryAfterSeconds` instead of replaying the request or sleeping through a long pause.

Follow the skill's bounded retry rule. Do not reconnect, switch profiles, or launch parallel processes to bypass `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, or `REQUEST_THROTTLED`. For `AUTH_BUSY`, let the active operation finish before the single allowed retry. Validate arguments or resolve approvals and conflicts before trying those operations again.
