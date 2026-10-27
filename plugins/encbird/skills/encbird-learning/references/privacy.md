# Keep PII out of learning requests

Read before sending learner text or context through EncBird tools or the script runner. Personally identifiable information (PII) can identify the learner or another private person, either directly or when details are combined. This rule applies to agent-supplied learning arguments; authentication remains inside the existing private runtime.

## Check the whole outgoing payload

Do not upload identifying names or handles, phone numbers, email or home addresses, exact birth dates, precise locations, government identifiers, account or payment identifiers, health or biometric details, credentials, or secrets. Check free text and metadata alike: search queries, phrases, answers, candidates, messages, evidence labels, identifiers, and operation keys. Private URLs, file paths, employer/client/project names, or combinations of role, place and date can also identify a person; omit those details when they do.

Keep only the information needed for the learning task. Broad interests, general work situations, ordinary counts and nonidentifying activity dates can remain when useful. A display name returned by basic context is not permission to send it back as learning evidence. Use original opaque tool/host identifiers only in their required fields, and unique, stable, nonidentifying keys for new operations. Never derive a key from PII. If a required actual source identifier contains PII, do not send that request or invent a replacement identity.

Inspect the intended arguments locally before a call or before placing them in script input. Do not upload raw context to test whether a filter will reject it, and do not reproduce excluded values in explanations, command arguments, logs, or debug files. Permission to use a conversation for learning does not waive this exclusion. When uncertain, omit the detail or item rather than asking for permission to upload PII.

## Minimize candidates without fabricating evidence

A host-authored candidate may generalize a useful observation before its first submission. For example, use “Wants to practice giving project updates in English” without identifying an employer, project or colleague. Keep it as a candidate interpretation, not a quotation or a user-role message. Do not invent replacement people, employers, events or dates and present them as facts.

Optional source messages must remain actual user evidence. Before their first submission, use an unchanged, self-contained, nonidentifying excerpt only when it preserves the original meaning and can retain the real message ID, role and observation time. Otherwise omit the message. Do not submit masked or paraphrased text as an actual utterance. Remove references to omitted messages and any candidate no longer supported by the remaining evidence; never manufacture messages to meet an evidence threshold. If nothing useful and safe remains, do not submit a batch.

Previously submitted source text and operation inputs are immutable for retries. Do not replace the content under an existing message ID/key or invent new IDs to resubmit a sanitized variant of an uncertain earlier operation.

## Preserve expression and quiz integrity

Before searching or registering an expression, check the proposed text for PII. A generic expression can be proposed separately if it preserves the learner's intent; obtain any required selection and payment approval for that expression. Do not silently substitute it in an approved or uncertain registration request.

If an actual quiz answer contains PII, do not submit the result. Explain that it was not submitted because it contains identifying information, without repeating the information, and continue feedback in the current conversation if useful. Do not redact, paraphrase or replace the answer and record it as the original attempt. A separately requested new attempt must use its own actual answer and learner-selected rating; it is not a retry of the earlier answer.

## Handle rejection and uncertain saves

Client and server filters are a backstop, not proof that arbitrary text is safe. Do not encode, split, spell out, transliterate, mask or move PII to another field, tool or transport to bypass them. The script runner follows the same rule.

A confirmed rejection before acceptance can be followed by a fresh privacy review of still-authorized, useful input under the tool's conflict rules. An uncertain earlier write must not be silently changed, replayed or given a new key. If its original payload contains PII, withhold it and explain that the learner needs reconciliation through supported EncBird channels without forwarding that payload. Report only the save or processing state actually confirmed by EncBird.
