export class SafeError extends Error {
  constructor(public code: string, message: string, public retryAfterSeconds?: number) { super(message); }
}

export function safeError(error: unknown): { error: { code: string; message: string; retryAfterSeconds?: number } } {
  if (error instanceof SafeError) return { error: { code: error.code, message: error.message,
    ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) } };
  return { error: { code: 'INTERNAL_ERROR', message: 'EncBird could not complete the operation. Retry or reconnect.' } };
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
