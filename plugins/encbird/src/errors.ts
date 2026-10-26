export class SafeError extends Error {
  constructor(public code: string, message: string, public retryAfterSeconds?: number) { super(message); }
}

export const uncertainOutcome = 'A write may already have taken effect; do not claim it was unsaved or replay it automatically. Check existing results with read tools or in EncBird first. An explicit retry must keep the complete original payload, approval, funding method, and operation key; if these are unavailable, ask an operator to reconcile the outcome.';
export const authCleanup = 'Run encbird_disconnect to finish any retained cleanup. If it reports reauthenticationRequired, use encbird_connect for same-account browser recovery. Retry sign-in only after cleanup succeeds and the learner still wants to connect; if cleanup cannot proceed, ask an operator to recover it without deleting credential or lock files.';
export const storageRecovery = 'Ask the local operator to restore safe access while preserving credential and lock files, which may retain pending revocation. Do not copy tokens, change the credential scope to bypass cleanup, or keep retrying before repair.';

export function safeError(error: unknown): { error: { code: string; message: string; retryAfterSeconds?: number } } {
  if (error instanceof SafeError) return { error: { code: error.code, message: error.message,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) } };
  return { error: { code: 'INTERNAL_ERROR', message: `The plugin could not complete the operation for an unclassified reason. Ask the local operator to inspect the plugin before retrying. ${uncertainOutcome} Preserve credential and lock files; use encbird_disconnect for pending cleanup when storage is usable.` } };
}

export class Secrets {
  private values = new Set<string>();
  add(...values: unknown[]) {
    for (const value of values) if (typeof value === 'string' && value.length > 0) this.values.add(value);
  }
  contains(value: string) { return [...this.values].some(secret => value.includes(secret)); }
  clean(value: unknown): unknown {
    if (typeof value === 'string') {
      for (const secret of [...this.values].sort((a, b) => b.length - a.length)) value = (value as string).split(secret).join('[redacted]');
      return (value as string).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]');
    }
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([key]) =>
        !/^(access.?token|previous.?access.?token|refresh.?token|id.?token|nonce|authorization|client.?secret|code.?verifier)$/i.test(key))
        .map(([key, item]) => [this.clean(key) as string, this.clean(item)]));
    }
    return value;
  }
}
