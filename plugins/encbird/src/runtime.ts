import { Auth } from './auth.js';
import { resolveBase } from './config.js';
import { Secrets, safeError } from './errors.js';
import { CredentialStore } from './store.js';
import { LearningTools } from './tools.js';

// MCP and the script runner use the same authentication, validation and error boundary.
export class PluginRuntime {
  readonly tools = new LearningTools();
  private readonly secrets = new Secrets();
  private auth?: Auth;
  constructor(private readonly clientName: () => string) {}

  async call(name: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    try {
      this.tools.validateInput(name, input);
      if (!this.auth) {
        const base = resolveBase();
        this.auth = new Auth(base, new CredentialStore(base, this.clientName(), this.secrets), this.secrets);
      }
      return this.secrets.clean(await this.tools.call(this.auth, name, input)) as Record<string, unknown>;
    } catch (error) { return this.secrets.clean(safeError(error)) as Record<string, unknown>; }
  }

  async waitForSignIn() { await this.auth?.waitForIdle(); }
  async stop() { await this.auth?.cancel(); }
}
