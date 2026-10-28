# Expressions and review

Read this reference when searching or registering expressions, or recording quiz attempts. Adapt explanations and practice format to the learner while preserving the following data and consent rules.

Apply [Privacy and evidence](privacy.md) before sending queries, expressions or answers. An actual answer containing PII must not be submitted or replaced with a sanitized answer under the same attempt; keep feedback in the current conversation and explain the unsaved result without repeating the identifying detail.

## Expression dictionary

Context returns only `dataSource`, `name`, and `cefrLevel`, not a private profile or a complete memory history. Expression lists/search return `items`, `truncated`, `moreMayExist`, and `coverage`. Report those limits instead of claiming exhaustive search. Read details with `expressionId`; the result is `data.expression`.

Keep the expression dictionary central. Registration accepts `phrase` and a stable `idempotencyKey`. When cost approval is missing, request the conditions first. A result with `status: approval_required` is a preview, not registration. Show the returned `approval.method` and `creditAmount`, obtain explicit approval of that use, and resubmit the same phrase/key with the returned approval object. Reuse an explicit approval already given for this expression, operation, method and amount; do not ask for it again. Changed conditions require a new matching approval. A free trial uses `free_trial` with 0 credits; credits uses `credits` with 1 credit. Never manufacture approval or infer it from a practice request. Report `charged`, `freeTrialConsumed`, and `quizPublication` as returned; a pending quiz publication does not mean a quiz is ready.

If `NOT_ENOUGH_CREDIT` is returned, tell the learner credits are insufficient and ask them to top up in EncBird before any explicit retry. Do not keep retrying an unchanged balance, infer a balance, switch payment methods, or change the original key and approval. Other errors provide their own recovery steps; a failed or uncertain registration must never be automatically replayed.

## Checking quiz availability

When the learner requests a readiness check for a newly registered expression, call `encbird_get_expression` once with its returned `expressionId` and `includeQuizAvailability: true`. This adds `data.quizAvailability.status` alongside `data.expression`. Omitting `includeQuizAvailability` or setting it to `false` keeps the existing response shape; absence of `quizAvailability` is not a readiness result.

| Status | Meaning |
| --- | --- |
| `ready` | A usable personal question exists for this expression. It is not guaranteed to appear in the next random review selection. |
| `not_ready` | No usable personal question exists for this expression now. Do not infer that generation is in progress, has failed, or will finish at any particular time. |

This read checks actual stored question readiness; registration's `quizPublication` value alone does not establish it. Perform only the requested check, without polling or triggering new question generation. Report the returned status within these limits.

## Recording quiz attempts

1. List review quizzes. Preserve `data.quizzes` and `data.phrases`, including `quizId`, `questionRevision`, any `expressionId`, `source`, `completionMode`, and `questionType`. Do not turn listing or question presentation into completion.
2. Present one question at a time by default. If the learner requests a batch, keep each question, answer, rating, and assistance record separate. Wait for the learner's actual answer before recording any attempt. For a translation question, use the Korean prompt without exposing the English answer first; for multiple choice, show the provided options. Keep the original answer, even if feedback later corrects it. Never submit a skipped question as an attempt.
3. Preserve assistance as `none`, `hint`, `answer`, or `unknown`. Revealing an answer dominates an earlier hint; if exposure history is uncertain use `unknown`. Returned answer text is not the learner's answer. Give feedback only after the learner attempts the question.
4. Use the learner's explicit selection for that attempt: 1 = Again (다시), 2 = Hard (어려움), 3 = Good (좋음), 4 = Easy (쉬움). When the rating is missing, show the number-label choices and wait for the learner to select one. Accept a number or an unambiguous selection of its English or Korean label, and submit the corresponding numeric `rating`. Do not ask again when a valid selection was already supplied. Clarify an ambiguous selection; do not infer a rating from correctness, confidence, tone, or assistance. A correct answer alone does not select Good or Easy.
5. Submit the exact `quizId`, `questionRevision`, optional `expressionId`, original `answer`, learner `rating`, `completed: true`, `assistance`, actual `sourceHost`/`sourceSessionId`, and a stable `idempotencyKey`. Reuse the same complete payload and key after a timeout or retry. Do not substitute a new question revision or change the answer while retrying that operation.

A revision conflict requires retrieving the current question and making a new attempt; it does not authorize relabeling the old attempt. Describe `quizStatus`, `reviewStatus`, `reviewDueAt`, and `replayed` exactly as returned. A fallback question can record a result while `reviewStatus` is `not_applicable`. A quiz result does not imply a separate chat completion, reward, or streak update. If an uncertain operation's original key is lost, explain that a safe retry cannot be reconstructed.
