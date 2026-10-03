# Consented learning memory

Read this reference before saving, correcting, or deleting learning memories.

Before collecting host/session context, establish the learner's permission for that source and persistence scope. Reuse permission already given for this scope; do not collect unrelated conversations, private files, contacts, secrets, or identifiers. Retain only useful learning excerpts. The runtime rejects detectable private identifiers and credentials before HTTP; do not disguise rejected content to bypass that boundary.

Memory writes use `operationKey`, `sourceHost`, `sourceSessionId`, and `messages` with actual IDs, roles (`user`, `assistant`, `generated`), minimal content, and actual RFC3339 `observedAt` timestamps. Never invent source identity or observation times. Assistant/generated text is context, never learner evidence.

Each proposed fact contains `category` (`profile`, `interest`, `work`, `learning`), a stable semantic `key`, `kind`, `content`, optional `occurredOn`, and `evidence` pairs of `messageId` and exact `quote`. Quotes must occur in the cited user message. Non-learning kinds are `state`, `event`, `plan`, or `habit`. Learning kinds are `weakness` or `strength`; these require at least four real learner messages and two independent supporting learner messages. Do not derive a stable weakness from a model-generated answer or a single attempt. A future occurrence is a plan. If evidence is insufficient, leave the fact unsaved.

A memory result returns `operationId`, operation `status`, and per-fact `{factId, category, version, status}`. It does not return private assertion text. Keep the accepted identity/version for corrections, deletions, and recommendation `factRefs`. Correct with `target`, new `fact`, and new actual source messages. Delete with `operationKey` and the exact `target`; do not send a transcript for deletion. Preserve operation keys/payloads on retries, and report conflicts or invalidation rather than claiming every fact was stored.
