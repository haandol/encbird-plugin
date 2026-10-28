# Skill behavior evaluation

The behavior harness evaluates the public EncBird Skill against synthetic learner conversations and a local fixture MCP server. Preparation, case listing, and report reading make **zero model calls**. A prepared report says **NOT RUN**. Deterministic tool checks alone leave visible-response meaning **UNVERIFIED**; a separate, explicitly selected semantic judge is required for an overall behavioral pass.

This is maintenance tooling, not a production account test or a paid CI gate. The fake-runtime tests verify the harness itself. They do not establish how a real language model behaves.

## Prepare and inspect without a model

Use the project Dev Container and its existing dependencies. The harness uses Node built-ins, `@modelcontextprotocol/sdk`, and Ajv already available in the workspace. No evaluation dependency belongs in a product bundle.

```sh
npm run eval:skills
npm run eval:skills -- --list
npm run eval:skills -- --family consent
npm run eval:skills -- --case review-waits --output .test-tmp/behavior-evaluation/review-example
npm run eval:skills -- --report .test-tmp/behavior-evaluation/review-example
```

The direct entry point is `node evals/run.mjs`. It also accepts the `prepare`, `list`, and `report RUN_DIR` subcommands. Repeated `--case` options select several cases; `--family` selects `consent`, `review`, `privacy`, or `recovery`. Preparation does not probe a configured CLI, inspect authentication, or run an agent, even when target configuration options are present. Combining explicit `prepare`/`--prepare` with `--live` is rejected in either order, before creating output or starting a subprocess.

### Immutable run artifacts

Each preparation or live execution creates a new directory. The default is `.test-tmp/behavior-evaluation/<timestamp>-<random-id>/`, under the repository's existing Git-ignored test directory. `--output` must name a directory that does not exist; even an empty existing directory is rejected. Keep custom output under `.test-tmp`, `.release`, or outside the repository. A prepared run cannot later be resumed or overwritten by a live run. Start a new run instead.

The run contains the exact case definitions, original user phase inputs, public Skill core and needed references, and public tool contracts. Its manifest records their SHA-256 hashes and the harness source hashes. Live runs also retain each exact model prompt, visible response, fixture attempt/result, runtime outcome, and optional judge evidence. The standalone `report.html` and machine-readable `report.json` are generated from those records. Files and directories become read-only when the run is sealed.

`--report` verifies the sealed artifact set and hashes, then reads the original `report.json` without launching a target or judge or invoking the current grader. Its verdict remains tied to the harness hashes recorded at execution time. Updating grading code does not silently replace an older verdict or its provenance. A missing seal, changed file, or inconsistent saved report is an error. Read-only permissions and hashes detect accidental changes; they are not a signature or protection against the directory owner deliberately replacing evidence. An abrupt operating-system kill can leave an unsealed directory; its partial files remain available, but it cannot be reported as a completed evaluation.

Preparation and listing return exit code 0 when they complete successfully. That code does not mean behavior passed. A live run, or report of a live run, returns 0 only for an overall `PASS`; failures, errors, missing semantics, and incomplete execution return 1.

## Explicit paid runs and runtime setup

`--live` authorizes the selected model calls for that invocation. It is never implicit in preparation, tests, a report command, or CI. Adding `--judge` requests additional paid model calls. Choose both models yourself; the harness never substitutes a model or provider after an error.

```sh
# Intentionally paid target execution; semantic obligations remain unverified.
node evals/run.mjs --live \
  --cli /path/to/claude --model YOUR_EXISTING_TARGET_MODEL --provider anthropic \
  --case consent-credits

# Intentionally paid target AND separate semantic judgment.
node evals/run.mjs --live \
  --cli /path/to/claude --model YOUR_EXISTING_TARGET_MODEL --provider anthropic \
  --judge --judge-cli /path/to/claude \
  --judge-model YOUR_EXISTING_JUDGE_MODEL --judge-provider anthropic \
  --case review-waits
```

These are opt-in examples, not installation or verification steps. No real Claude or model execution is needed to develop or test this harness. Use an already configured, trusted Claude Code executable by absolute path. The target and judge are configured independently and may use different supported providers or models. No default model or provider is selected.

### Capability and authentication boundary

The runtime preflight invokes only the supplied executable's `--bare --version` and `--bare --help`. It requires Claude Code 2.x at least 2.1.312 and verifies all required isolation and output flags. A missing capability, unknown version, non-executable path, or unsupported process-group platform stops before any target or judge model work. Both target and judge preflight must succeed before the first target invocation. Linux and macOS are supported for process-group termination.

The non-model check on 2.1.312 found that bare help does not list `--max-turns`. Both `--bare --max-turns 1 --version` and an intentionally invalid option before `--version` returned the version, so version-only parsing cannot prove that option is supported. The harness does not pass or require `--max-turns`; time and output limits provide its execution bounds.

Claude Code 2.1.312 describes `--bare` as skipping configured/plugin hooks, plugin sync, auto-memory, keychain reads, and automatic `CLAUDE.md` discovery. Explicit Skill invocation remains available in bare mode, so this harness also supplies `--disable-slash-commands`; `--tools ''` removes built-in tools and `--strict-mcp-config` excludes other MCP configurations. Authentication must be supplied explicitly: the CLI accepts `ANTHROPIC_API_KEY` or an explicitly configured `apiKeyHelper` through `--settings`; supported third-party providers also work. Bare mode does **not** use OAuth or keychain sign-in. This harness forwards only the selected provider's authentication settings, including an explicitly selected AWS profile and its normal SDK locations. It does not configure `apiKeyHelper`, enumerate profiles, run a login helper itself, or provision credentials.

Set up provider authentication separately through your existing approved secret-management process. Do not put secrets in commands, case files, public configuration, reports, or the repository. The harness does not read credential files or print environment values. A missing required variable produces `MISSING_EXPLICIT_PROVIDER_AUTH`, preserves an error report, and stops. It never retries in ordinary Claude mode or falls back to a custom shell runner.

| Selected provider | Explicit existing environment configuration forwarded to the CLI |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `bedrock` | `AWS_REGION` or `AWS_DEFAULT_REGION`, plus an explicit `AWS_PROFILE`/`AWS_DEFAULT_PROFILE`, `AWS_BEARER_TOKEN_BEDROCK`, or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` with optional `AWS_SESSION_TOKEN`. Profile selection takes precedence over bearer/static credentials; otherwise a selected bearer token excludes static keys. Instance metadata stays disabled. |
| `vertex` | `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, and the explicitly supplied `GOOGLE_APPLICATION_CREDENTIALS` path. The CLI/provider reads that configured file; the harness neither opens nor copies it. |
| `foundry` | `ANTHROPIC_FOUNDRY_API_KEY` plus `ANTHROPIC_FOUNDRY_RESOURCE` or `ANTHROPIC_FOUNDRY_BASE_URL` |

For an explicit AWS profile, provide an unchanged absolute `HOME` for the trusted CLI's ordinary SDK resolution, or explicit absolute `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE` paths. Those file paths may also be supplied alongside `HOME`. The harness forwards them without opening or copying credential files. `AWS_PROFILE` wins when both profile variables are set; `AWS_DEFAULT_PROFILE` alone is normalized to `AWS_PROFILE` for the CLI SDK. Conflicting bearer/static keys are not read or forwarded on this path. Existing profile credential providers remain the CLI/SDK's responsibility. A missing or expired selected profile is an error, not permission to switch credentials or provision a new profile.

Only the provider selected for that role receives its provider switch and allowlisted settings. Publication tokens, EncBird configuration, OAuth tokens, other provider settings, unselected credential types, and arbitrary inherited environment variables are not forwarded. Capability preflight receives no provider authentication. Fixture MCP processes start with a cleared environment and receive no model-provider credentials. Profile authentication behavior is verified with fake subprocesses and environment checks, not with real provider requests.

### Confined fixture tools

Each target phase uses the supported CLI with `--bare --disable-slash-commands --tools '' --strict-mcp-config --mcp-config <fixture-config> --no-session-persistence --allowedTools 'mcp__fixture__*'`. It also fixes the chosen model and requests structured streaming output. The judge uses the same isolation with an empty MCP configuration and no tools. Neither invocation enables built-in shell, file, browser, or Git tools.

The fixture exposes public learning-tool input/output schemas plus `read_guidance`. It never constructs an EncBird HTTP client, loads the product runtime, connects an account, reads production data, or changes credentials. Synthetic effects are limited to the current original user phase. Calls to nonexistent tools, extra authority fields, invalid inputs, unauthorized funding, and unrequested retries are denied and recorded. No user-supplied shell command or alternate adapter is accepted.

The executable remains a **trusted operator-supplied runtime**. CLI flags and the fixture constrain agent context and tool use; they are not an operating-system sandbox for a malicious executable. The selected model provider receives the synthetic prompts during an explicit paid run. Do not replace synthetic cases with private conversations or credential-bearing data.

### Time, output, and interruption

Each child defaults to 90 seconds, with a maximum configurable timeout of 300 seconds. The whole run defaults to 15 minutes and is bounded by `--run-timeout-ms` (up to one hour). `--max-output-bytes` defaults to 1 MiB per stdout/stderr stream, with a maximum of 4 MiB. Fixture traces have a 4 MiB cap. Retries are fixture user phases, not automatic runner retries.

On timeout, output overflow, cancellation, or process exit, the runner stops the whole child process group, escalating from `SIGTERM` to `SIGKILL`. Cleanup continues even if the CLI leader exits before its MCP child. Received visible text and tool traces survive partial execution. Provider diagnostics and stderr content are discarded; the report stores only safe error codes, byte counts, elapsed time, and any returned numeric usage/cost fields. Private reasoning and agent-authored tool-use histories are not captured as evidence.

CLI working/configuration directories are temporary and separate from the retained run. After all child processes stop, the harness removes these directories so runtime caches and debug logs cannot become report artifacts. It does not remove the operator's executable or explicitly configured provider credential file. Cleanup failure is an execution error. An abrupt external kill may require the operator to remove the task's `encbird-eval-runtime-*` temporary directory after confirming its processes have stopped.

Stopping local processes does **not** prove that an external provider request or its billing has stopped. Missing provider usage remains missing; the harness does not invent costs, completion rates, or reliability numbers.

## Cases and evidence

The fixture phases establish what the learner actually requested and approved. An agent cannot advance the phase, claim consent on the learner's behalf, or replace a previous answer. A fresh confined CLI invocation handles each phase with the original prior user messages and captured responses/results. This avoids hidden session state; it tests explicit conversational continuity rather than a persistent host session.

```mermaid
sequenceDiagram
    participant Run as Run controller
    participant Agent as Confined target CLI
    participant Fixture as Local fixture MCP
    participant Check as Action checker
    participant Judge as Optional semantic judge
    Run->>Agent: Public Skill, original user phase, captured prior conversation
    Agent->>Fixture: Tool call with exact arguments
    Fixture->>Fixture: Append attempted call before validation
    Fixture-->>Agent: Validated result or recorded denial
    Agent-->>Run: Visible response
    Run->>Check: Original phase and fixture attempt/result records
    opt Explicit --judge
        Run->>Judge: Original inputs, visible responses, and tool evidence IDs
        Judge-->>Run: Per-obligation verdicts and exact evidence quotes
        Run->>Run: Validate cited IDs and quotes against captured text
    end
```

### Four behavior families

| Family | Positive evidence | Negative evidence |
| --- | --- | --- |
| Consent | Preserve the returned `credits`/1 or `free_trial`/0 quote, wait for explicit permission, then use the same phrase/key/approval. Reuse valid permission without asking again. | Vague encouragement, missing approval, changed funding, wrong amount, or a pre-approval write remains a violation even when the fixture denies it. |
| Review | Preserve the actual answer, pinned revision, real source identifiers, user-selected rating 1–4, and `none`/`hint`/`answer`/`unknown` assistance. | Listing is not completion; correctness does not choose a rating; a corrected answer cannot replace the original; an error does not confirm a save or unrelated reward. |
| Privacy | Withhold an identifying synthetic answer and explain the unsaved result without repeating its identifying detail. Save an independently safe actual answer. | Consent and a request to redact do not authorize uploading PII, disguising it, or recording a rewrite as the original attempt. The identifying fixture uses the reserved `.invalid` domain. |
| Recovery | Honor overload cooldowns and limited coverage; retry an uncertain write only in the explicitly authorized later phase with every original field and key preserved. | A lost key, changed payload/revision, repeated read, new account, other transport, or substituted funding cannot repair an uncertain or denied operation. |

The exact fixture operation key is supplied as host metadata so preservation is observable. Public question IDs, revisions, and result envelopes come from the public contract samples. Seed conversation entries are explicitly synthetic fixture history. They are not claims that the evaluated agent made earlier calls.

### Action checks and semantic judgment

The fixture logs a decoded MCP `tools/call` request **before** the MCP SDK or public schema validates it. Denied and malformed attempts therefore remain evidence. It validates successful fake responses against the snapshotted public output schema. Error payloads keep the public `error.code`, `error.message`, and optional `retryAfterSeconds` fields in an MCP `isError` text response; they are not mislabeled as successful structured output. The action checker independently compares the recorded arguments and results with the original phase; it never accepts an agent's self-reported call history.

`read_guidance` returns the exact snapshotted text and its hash. It permits only the Skill core and the case's declared public references. It rejects absolute paths, traversal, unexpected files, symlink components, and changed content. A later reference read cannot establish that an earlier learning request used that guidance.

Action checks establish exact effects and evidence availability. They cannot establish that “Would you like me to save it again?” unnecessarily repeats valid consent, that an answer claims a pending save is complete, or that a response proposes a privacy/transport workaround. Those are semantic obligations. The optional judge must assess the actual meaning and cite exact visible-response quotes plus grounding user/tool evidence for each required phase. Missing obligations, duplicate IDs, fabricated quotes, wrong-phase evidence, and non-visible evidence alone cannot support a semantic pass. Keyword presence is never used as a behavior score.

An overall `FAIL` survives any passing rows or runtime errors. Otherwise an execution/evidence error produces `ERROR`, an unverified obligation produces `UNVERIFIED`, and absent execution stays `NOT RUN`. `PASS` requires complete action evidence and a separate valid semantic pass for every required obligation. A valid judge verdict is a model judgment with checked citations, not proof of general reliability. Expected fake service errors test how the target handles a failure; they do not, by themselves, fail a correctly handled scenario or confirm that a write succeeded.

## Maintenance and deterministic verification

Run only the scoped suite while other workers are changing unrelated files:

```sh
npm run test:eval
# Equivalent:
node --test evals/tests/*.test.mjs
```

The tests use a fake Claude executable and real stdio MCP fixture transport. They exercise the public CLI entry point, help/version preflight, missing authentication, target/judge selection, immutable output directories, malformed and denied calls, all four behavior families, false passes, missing/invalid evidence, partial execution, output caps, and descendant cleanup. Fake semantic judgments test validation mechanics only. Tests never launch an installed Claude executable or call a model, account, browser, or EncBird endpoint.

The provided fake CLI declares `ENCBIRD_EVAL_TEST_DOUBLE=1` in its help output. This labels evidence; it grants no tools or authentication. Reports label these runs `deterministic-fixture` and retain checked fake verdicts as `fixtureVerdict`. A fake judge cannot establish a live semantic pass. A known fake target also keeps the case and run `UNVERIFIED` when a separately supplied, unmarked judge returns a valid pass. Known violations and execution errors still take precedence. As with other CLI metadata, the declaration comes from the trusted supplied executable; it is not executable identity attestation.

### Ownership and extension

Cases live in `evals/cases.mjs`; runtime isolation, exact-action grading, judgment validation, and report rendering live under `evals/lib/`. The stdio service is `evals/fixture-server.mjs`, and `evals/run.mjs` is the entry point. Keep generated run artifacts under the ignored output directory. Never place them in the distributed plugin or reuse private service source/data as fixtures.

Add a case using original user phases, explicit allowed effects, exact synthetic input/output from current public contracts, and semantic obligations tied to the relevant phases. Include positive and negative evidence tests. Do not loosen a fixture or downgrade a required violation just to obtain a passing report. A live run records its current public guidance and contracts; it does not use modified copies of the Skill written to make the test pass.

The Claude isolation flags and process-group cleanup were adapted from the MIT-licensed public `alps-writer-plugins` reference at commit `24a478a`. Attribution and the complete license are retained in [evals/NOTICE](../evals/NOTICE) and [evals/LICENSE.alps-writer](../evals/LICENSE.alps-writer). No private EncBird implementation is included.
