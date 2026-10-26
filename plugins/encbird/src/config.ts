import { object, requestJson, serviceUrl } from './http.js';
import { SafeError } from './errors.js';

export const DEFAULT_BASE = 'https://api.encbird.com/v1/mcp-learning';
export const REDIRECT_URI = 'http://localhost:18765/oauth/callback';
export interface OAuthConfig {
  issuer: string; clientId: string; authorizationEndpoint: string; tokenEndpoint: string;
  revocationEndpoint: string; resource: string; scopes: string[]; redirectUri: string;
}
export function isLoopback(url: URL) { return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
export function resolveBase(value = process.env.ENCBIRD_API_BASE_URL): string {
  if (value === undefined) return DEFAULT_BASE;
  try {
    const url = serviceUrl(value);
    if (url.protocol !== 'http:' || !isLoopback(url) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new SafeError('INVALID_CONFIG', 'ENCBIRD_API_BASE_URL is invalid. Ask the local operator to unset it for production or configure an explicit loopback HTTP URL without credentials, query, or fragment for local development. Retry only after correcting the configuration.'); }
}
export function validateBase(base: string): string { return base === DEFAULT_BASE ? base : resolveBase(base); }
export function validateOAuth(input: unknown, base: string): OAuthConfig {
  base = validateBase(base);
  const data = object(input);
  for (const key of ['issuer', 'clientId', 'authorizationEndpoint', 'tokenEndpoint', 'revocationEndpoint', 'resource']) {
    if (typeof data[key] !== 'string' || !data[key] || /\s/.test(data[key] as string)) throw new SafeError('INVALID_CONFIG', 'Sign-in configuration is missing or has invalid required fields. Ask the EncBird operator to repair the configuration, then retry encbird_connect; do not supply tokens or substitute endpoints.');
  }
  const allowedScopes = new Set(['openid', `${data.resource}/learning.read`, `${data.resource}/learning.write`]);
  if (data.redirectUri !== REDIRECT_URI || !Array.isArray(data.scopes) || !data.scopes.includes('openid') ||
      !data.scopes.includes(`${data.resource}/learning.read`) || new Set(data.scopes).size !== data.scopes.length ||
      !data.scopes.every(scope => typeof scope === 'string' && allowedScopes.has(scope))) {
    throw new SafeError('INVALID_CONFIG', 'Sign-in requires openid, resource/learning.read, optional resource/learning.write, and the exact registered loopback redirect. Ask the EncBird operator to repair configuration before retrying encbird_connect; do not bypass scope or callback checks.');
  }
  const local = base !== DEFAULT_BASE;
  try {
    const resource = serviceUrl(data.resource);
    if (resource.protocol !== 'https:' && !(local && resource.protocol === 'http:' && isLoopback(resource))) throw new Error();
    for (const key of ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'revocationEndpoint']) {
      const url = serviceUrl(data[key]);
      if (url.username || url.password || url.search || url.hash ||
          (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && url.origin === new URL(base).origin))) throw new Error();
    }
    const authOrigin = new URL(data.authorizationEndpoint as string).origin;
    if ([data.tokenEndpoint, data.revocationEndpoint].some(url => new URL(url as string).origin !== authOrigin)) throw new Error();
  } catch { throw new SafeError('INVALID_CONFIG', 'Sign-in endpoints failed trust validation. Stop sign-in and ask the EncBird operator to repair the configuration before retrying encbird_connect; do not bypass validation or substitute endpoints.'); }
  return data as unknown as OAuthConfig;
}
export async function bootstrap(base: string): Promise<OAuthConfig> {
  base = validateBase(base);
  const { status, body } = await requestJson(`${base}/config`);
  if (status !== 200) throw new SafeError('CONFIG_UNAVAILABLE', 'EncBird sign-in configuration could not be loaded. Retry encbird_connect after service access is restored; ask the EncBird operator if it persists. Do not substitute endpoints or credentials.');
  const data = object(body);
  if (data.apiVersion !== '1') throw new SafeError('API_VERSION_UNSUPPORTED', 'This plugin requires EncBird API version 1, but the service did not advertise it. Ask the operator to install a compatible plugin and service before retrying encbird_connect.');
  return validateOAuth(data.oauth, base);
}
