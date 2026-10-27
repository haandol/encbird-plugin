import { SafeError, uncertainOutcome } from './errors.js';

const permission = 'This connection does not have permission for the operation. Ask the EncBird operator to confirm that access is allowed and configured. If a new grant is needed, run encbird_disconnect to finish cleanup, then encbird_connect with the same account and requested consent. Retry only after permission is available; do not bypass authorization.';
const concurrent = 'Learning state changed during the request. Wait for the competing operation to finish, then explicitly retry only the complete original payload and operation key, including any approval. Do not change identifiers or funding to escape the conflict; ask the EncBird operator if it persists.';
const messages: Record<string, string> = {
  NOT_ENOUGH_CREDIT: 'Insufficient credits. Ask the learner to top up credits in EncBird before retrying. Do not keep retrying an unchanged balance or switch funding automatically. A legitimate retry must keep the original operation key, payload, and approved payment method and amount; do not infer the balance or amount needed.',
  FREE_TRIAL_UNAVAILABLE: 'The approved free trial is unavailable. Stop retries with that approval. If the learner wants to continue, request a fresh encbird_add_expression preview for the same phrase and operation key without approval, then ask for explicit approval of the returned funding method and amount. Do not switch to credits automatically.',
  CREDIT_PRICE_CHANGED: 'The approved credit price is no longer current. Request a fresh encbird_add_expression preview for the same phrase and operation key without approval. Ask the learner to approve the returned method and amount before continuing; do not infer a price or change funding automatically.',
  MCP_APPROVAL_INVALID: 'The registration approval is invalid. Retrieve an encbird_add_expression preview for the same phrase and operation key without approval, and use only its returned approval after the learner explicitly agrees. Do not manufacture approval or switch funding automatically.',
  INVALID_CREDIT: 'The credit request was rejected as invalid; this does not establish a credit shortage. Ask the EncBird operator to check the registration approval and credit handling before retrying. Preserve the original key and approved funding; do not guess an amount.',
  INVALID_IDEMPOTENCY_KEY: 'The operation key was rejected as invalid. For a first attempt with confirmed input rejection, correct the key to the tool schema format once, then keep that key for the operation. If an earlier write may have been accepted, recover its exact original valid key or ask the EncBird operator to reconcile it; do not invent a replacement key to repeat that write or evade a conflict. Never replay a write automatically.',
  IDEMPOTENCY_KEY_CONFLICT: 'This operation key was already used with different request data. Recover and compare the complete original payload, including approval, before an explicit retry with that same key. Do not change keys to bypass the conflict; if the original request cannot be recovered, ask the EncBird operator to reconcile it.',
  IDEMPOTENCY_RESULT_UNAVAILABLE: 'The original operation has no reusable result. Check existing expressions with encbird_search_expressions or encbird_get_expression, then ask the EncBird operator to reconcile the original operation before another write. Do not use a new key to register or charge again.',
  LEARNING_CONFLICT: 'The request conflicts with learning or source state; the code does not distinguish changed evidence from a retry conflict. Check encbird_get_memory_candidate_status if a batch ID is available, or encbird_list_suggested_expressions for a suggestion. Compare the original payload, source, IDs, and key before retrying it unchanged. Never change IDs or keys to bypass the conflict; ask the EncBird operator if it persists.',
  MCP_QUIZ_REVISION_CONFLICT: 'The quiz question changed. Use encbird_list_review_quizzes to retrieve the current question and let the learner make a new attempt and choose a rating. Do not submit the old answer under a new revision or key to bypass the conflict.',
  MCP_QUIZ_CONCURRENT_CHANGE: concurrent,
  REVIEW_CONCURRENT_CHANGE: concurrent,
  CREDIT_CONCURRENT_CHANGE: 'Credit state changed during the operation; this does not establish a shortage or a new balance. Wait for the competing operation to finish, then explicitly retry the complete original payload, key, and approval. Do not switch funding; ask the EncBird operator if contention persists.',
  LEARNING_SOURCE_UNAVAILABLE: 'The learning source or account is unavailable. Stop submitting or polling that source. Have the learner check its availability in EncBird and ask the EncBird operator if access should exist; retry only after availability is confirmed. Do not recreate deleted sources or invent replacement IDs.',
  MEMORY_CANDIDATE_NOT_FOUND: 'The candidate batch was not found for this account. Verify candidateId against the original encbird_submit_memory_candidates result. Stop polling if it is missing; ask the EncBird operator to investigate before resubmitting. Do not infer that no candidates were processed or create new IDs to repeat the batch.',
  RESOURCE_NOT_FOUND: 'The requested content was not found. Refresh the matching EncBird list or search tool and use a returned identifier. If it remains absent, ask the learner to choose available content; do not recreate it or repeat registration or charges to recover it.',
  PROFILE_NOT_FOUND: 'The EncBird learning profile was not found. Have the learner check their account setup in EncBird and contact the EncBird operator if needed. Resume only after the profile is available; do not create a replacement identity.',
  PROFILE_DELETED_QUIT: 'The EncBird profile has been deleted. Stop learning calls and run encbird_disconnect for connection cleanup. Have the learner contact EncBird support about their account; do not recreate the profile or retry writes.',
  MCP_GENERATION_DISABLED: 'This expression has no cached meaning and generation is disabled. Ask the EncBird operator whether generation can be enabled for this environment. Retry only after it is enabled and the learner still approves the original operation, using the same payload, key, and funding; do not generate or save a substitute through another tool.',
  INVALID_REQUEST: 'EncBird rejected the request inputs. Check the discovered tool schema and actual source data, then correct the inputs before submitting. Never invent source IDs, evidence, consent, or approval; do not alter an earlier uncertain write under its key.',
  INVALID_MCP_QUIZ_RESULT: 'The quiz result is missing or has invalid attempt data. Use the listed quiz and revision, the actual learner answer, completion and assistance, actual source identifiers, and an explicit learner rating from 1 to 4. Submit only once those inputs are available; never infer a rating or relabel an earlier attempt.',
  INVALID_MCP_REVIEW: 'The review result is invalid. Check the discovered tool schema and collect the actual completed attempt and explicit learner rating before submitting. Do not infer completion or change an earlier operation to bypass validation.',
  VOCAB_INVALID_PHRASE: 'EncBird could not accept this phrase as a meaningful expression. Ask the learner to clarify the intended expression before a new registration preview and any required approval. Do not silently replace the phrase in an earlier uncertain write.',
  EMPTY_PHRASE: 'No expression was provided. Ask the learner for the intended phrase, then request an encbird_add_expression preview before any required approval; do not invent a phrase.',
  VOCAB_ALREADY_EXISTS: 'The expression already exists. Use encbird_search_expressions and encbird_get_expression to retrieve it instead of registering or charging again.',
  PERMISSION_REQUIRED: permission,
  CONNECTION_FORBIDDEN: permission,
  NOT_ALLOWED_RESOURCE: 'This account is not allowed to access the requested content. Use content returned by its own EncBird list tools or ask the EncBird operator to check access. Retry only after legitimate access is confirmed; do not substitute another account or bypass authorization.',
  AUTHENTICATION_REQUIRED: 'EncBird requires authentication. Run encbird_connect and follow its browser or cleanup instructions before resuming; use the same account for recovery. Do not automatically repeat a learning write.',
  UNAUTHORIZED: 'EncBird rejected authorization for this operation. Check connection progress with encbird_connect; if already connected, ask the EncBird operator to check access before retrying. Do not bypass authorization or automatically repeat a write.',
  CONNECTION_INACTIVE: 'This connection is inactive. Run encbird_disconnect to finish any retained cleanup, then encbird_connect for browser sign-in. If cleanup requires reauthentication, recover with the same account. Resume learning only after connected; do not automatically replay the failed write.',
  RATE_LIMITED: `EncBird is limiting requests. Stop repeated calls and wait before an explicit retry; ask the EncBird operator if the limit persists. ${uncertainOutcome}`,
  SERVICE_UNAVAILABLE: `EncBird is temporarily unavailable. Wait for service recovery before an explicit retry; ask the EncBird operator if it persists. ${uncertainOutcome}`,
  LEARNING_UNAVAILABLE: `The learning service could not complete the operation. Wait for service recovery before an explicit retry; ask the EncBird operator if it persists. ${uncertainOutcome}`,
};

function classifiedError(status: number, code: string): SafeError {
  // HTTP authentication always wins, even over a recognized domain code.
  if (status === 401) return new SafeError('AUTH_REQUIRED', 'EncBird rejected authorization for this request. Ask the EncBird operator to repair configuration or authorization before retrying; repeating connection setup or cleanup does not force a rejected unexpired token to refresh. After repair, use encbird_connect to resume retained setup or recovery, or encbird_disconnect to finish cleanup. Follow same-account reauthentication if requested. Preserve credential records and do not repeatedly retry, bypass sign-in, or claim cleanup is complete.');
  if (Object.hasOwn(messages, code)) return new SafeError(code, messages[code]!);
  // A code unknown to this plugin is not evidence of a particular domain cause.
  if (code !== 'API_ERROR') return new SafeError(code, `EncBird returned an error code this plugin does not recognize. Ask the EncBird operator to check this code and plugin/service compatibility before retrying; do not infer its cause from the code or change funding, identity, or operation keys. ${uncertainOutcome}`);
  if (status === 403) return new SafeError('CONNECTION_FORBIDDEN', permission);
  if (status === 429) return new SafeError(code, `EncBird is limiting requests. Stop repeated calls and wait before an explicit retry; ask the EncBird operator if it persists. ${uncertainOutcome}`);
  if (status >= 500) return new SafeError(code, `EncBird could not complete the request because of a service error. Wait for service recovery; ask the EncBird operator if it persists. ${uncertainOutcome}`);
  return new SafeError(code, `EncBird rejected the request without a recognized error code. Check the discovered tool schema and ask the EncBird operator to investigate before retrying. ${uncertainOutcome}`);
}

function boundedPause(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 86_400) return value;
}

export function apiError(status: number, code: string, retryAfterSeconds?: number, structuredRetryAfterSeconds?: unknown): SafeError {
  const structuredPause = code === 'RATE_LIMITED' ? boundedPause(structuredRetryAfterSeconds) : undefined;
  if (code === 'API_ERROR' && (status === 429 || status === 503)) code = status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE';
  const error = classifiedError(status, code);
  if (status === 401) return error;
  // A pause may accompany a business rejection; preserve its specific recovery action.
  if (status === 429 || status === 503 || error.code === 'RATE_LIMITED') {
    const headerPause = status === 429 || status === 503 ? boundedPause(retryAfterSeconds) : undefined;
    error.retryAfterSeconds = Math.max(headerPause ?? 0, structuredPause ?? 0) || 30;
  }
  return error;
}
