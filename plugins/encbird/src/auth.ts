import { safeError, type Secrets } from './errors.js';
import { authenticationPending, Connection } from './connection.js';
import { openBrowser } from './oauth.js';
import { CredentialStore } from './store.js';

// Coordinates process-local tasks; Connection owns state under the store lock.
export class Auth {
  private task?: Promise<void>;
  private abort?: AbortController;
  private failure?: ReturnType<typeof safeError>;
  constructor(readonly base: string, readonly store: CredentialStore, readonly secrets: Secrets,
    private browser = openBrowser, private callbackTimeoutMs = 180_000) {}

  async connect(): Promise<Record<string, unknown>> {
    if (this.task) return authenticationPending();
    if (this.failure) { const failure = this.failure; this.failure = undefined; return failure; }
    let started!: (value: Record<string, unknown>) => void;
    const result = new Promise<Record<string, unknown>>(resolve => { started = resolve; });
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.task = this.store.withLock(async tx => {
      const connection = new Connection(this.base, tx, this.secrets);
      await connection.connect(started, signal, url => this.browser(url), this.callbackTimeoutMs);
    }).catch(error => { this.failure = safeError(error); started(this.failure); }).finally(() => { this.task = undefined; this.abort = undefined; });
    return result;
  }
  async waitForIdle() { await this.task; }
  async cancel() { this.abort?.abort(); await this.task; }
  async request(method: string, path: string, body?: unknown) {
    return this.store.withLock(tx => new Connection(this.base, tx, this.secrets).request(method, path, body));
  }
  async callLearningTool(name: string, input: Record<string, unknown>) {
    return this.store.withLock(tx => new Connection(this.base, tx, this.secrets).callLearningTool(name, input));
  }
  async disconnect() {
    await this.cancel(); this.failure = undefined;
    return this.store.withLock(tx => new Connection(this.base, tx, this.secrets).disconnect());
  }
}
