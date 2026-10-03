# Expressions and review

Read this reference when searching or registering expressions, or recording quiz attempts. Adapt explanations and practice format to the learner while preserving the following data and consent rules.

## Expression dictionary

Context returns only `dataSource` and `cefrLevel`, not a private profile or a complete memory history. Expression lists/search return `items`, `truncated`, `moreMayExist`, and `coverage`. Report those limits instead of claiming exhaustive search. Read details with `expressionId`; the result is `data.expression`.

Keep the expression dictionary central. Registration accepts `phrase` and a stable `idempotencyKey`. A result with `status: approval_required` is a preview, not registration. Show the returned `approval.method` and `creditAmount`, ask for explicit approval of that exact use, and only then resubmit the same phrase/key with the returned approval object. A free trial uses `free_trial` with 0 credits; credits uses `credits` with 1 credit. Never manufacture approval or infer it from a practice request. Report `charged`, `freeTrialConsumed`, and `quizPublication` as returned; a pending quiz publication does not mean a quiz is ready.

## Recording quiz attempts

1. List review quizzes. Preserve `data.quizzes` and `data.phrases`, including `quizId`, `questionRevision`, any `expressionId`, `source`, `completionMode`, and `questionType`. Do not turn listing or question presentation into completion.
2. Present one question at a time by default. If the learner requests a batch, keep each question, answer, rating, and assistance record separate. Wait for the learner's actual answer before recording any attempt. For a translation question, use the Korean prompt without exposing the English answer first; for multiple choice, show the provided options. Keep the original answer, even if feedback later corrects it. Never submit a skipped question as an attempt.
3. Preserve assistance as `none`, `hint`, `answer`, or `unknown`. Revealing an answer dominates an earlier hint; if exposure history is uncertain use `unknown`. Returned answer text is not the learner's answer. Give feedback only after the learner attempts the question.
4. Use the learner's explicit rating of 1, 2, 3, or 4 for that attempt. Ask only if it is missing; do not ask again when it was already supplied. Do not infer a rating from correctness, confidence, tone, or assistance. Use rating labels only if provided by the host or returned data.
5. Submit the exact `quizId`, `questionRevision`, optional `expressionId`, original `answer`, learner `rating`, `completed: true`, `assistance`, actual `sourceHost`/`sourceSessionId`, and a stable `idempotencyKey`. Reuse the same complete payload and key after a timeout or retry. Do not substitute a new question revision or change the answer while retrying that operation.

A revision conflict requires retrieving the current question and making a new attempt; it does not authorize relabeling the old attempt. Describe `quizStatus`, `reviewStatus`, `reviewDueAt`, and `replayed` exactly as returned. A fallback question can record a result while `reviewStatus` is `not_applicable`. A quiz result does not imply a separate chat completion, reward, or streak update. If an uncertain operation's original key is lost, explain that a safe retry cannot be reconstructed.
