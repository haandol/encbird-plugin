# Consented learning candidates

Read this reference before submitting profile, activity, or learning observations for EncBird to evaluate. The plugin has no direct memory access: do not request memory content, search, record IDs, versions, corrections, deletions, exports, or `factRefs`.

## Source and permission

Establish the learner's permission for the source and persistence scope before collecting host/session context. Reuse permission already given for this scope. Do not collect unrelated conversations, private files, contacts, secrets, or identifiers. Send only useful learning excerpts; never disguise rejected private content to bypass input validation.

## Submission and status

Use `encbird_submit_memory_candidates` with the original stable `operationKey`, actual `sourceHost` and `sourceSessionId`, and 1–20 candidates. Each candidate has a stable `id`, `kind` (`profile`, `activity`, or `learning`), `content`, and actual RFC3339 `observedAt`. Optional `evidenceIds` must reference actual user messages included in optional `messages`; never invent evidence, source identities, or timestamps. Candidate summaries and assistant/generated text are not user utterances.

EncBird evaluates candidates internally before deciding whether to update learning memory; submission does not directly change memory or the basic profile. Strengths and weaknesses require at least four actual user utterances and two independent supporting user evidence items. Insufficient evidence can result in no new facts.

Submission returns only `{candidateId,status}`. Use that returned ID with `encbird_get_memory_candidate_status` when a status check is needed; do not poll in a loop. Status is `pending`, `processing`, `completed`, `cancelled`, or `failed`. `pending` confirms receipt, and even `completed` does not confirm memory was added. Do not claim a stored fact or infer its contents. Preserve the complete original payload and key for an explicit retry after following the error's recovery instructions; never automatically replay a write.
