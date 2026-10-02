import { object, requestJson } from './http.js';
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
    const url = new URL(value);
    if (url.protocol !== 'http:' || !isLoopback(url) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new SafeError('INVALID_CONFIG', 'ENCBIRD_API_BASE_URL must be an explicit loopback HTTP URL.'); }
}
export function validateOAuth(input: unknown, base: string): OAuthConfig {
  const data = object(input);
  for (const key of ['issuer', 'clientId', 'authorizationEndpoint', 'tokenEndpoint', 'revocationEndpoint', 'resource']) {
    if (typeof data[key] !== 'string' || !data[key] || /\s/.test(data[key] as string)) throw new SafeError('INVALID_CONFIG', 'OAuth bootstrap configuration is invalid.');
  }
  if (data.redirectUri !== REDIRECT_URI || !Array.isArray(data.scopes) || !data.scopes.includes('openid') ||
      !data.scopes.every(scope => typeof scope === 'string' && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope))) {
    throw new SafeError('INVALID_CONFIG', 'OAuth requires openid and the exact registered loopback redirect.');
  }
  const local = base !== DEFAULT_BASE;
  try {
    for (const key of ['issuer', 'authorizationEndpoint', 'tokenEndpoint', 'revocationEndpoint']) {
      const url = new URL(data[key] as string);
      if (url.username || url.password || url.search || url.hash ||
          (url.protocol !== 'https:' && !(local && url.protocol === 'http:' && url.origin === new URL(base).origin))) throw new Error();
    }
    const authOrigin = new URL(data.authorizationEndpoint as string).origin;
    if ([data.tokenEndpoint, data.revocationEndpoint].some(url => new URL(url as string).origin !== authOrigin)) throw new Error();
  } catch { throw new SafeError('INVALID_CONFIG', 'OAuth endpoint trust validation failed.'); }
  return data as unknown as OAuthConfig;
}
export async function bootstrap(base: string): Promise<OAuthConfig> {
  const { status, body } = await requestJson(`${base}/config`);
  if (status !== 200) throw new SafeError('CONFIG_UNAVAILABLE', 'EncBird sign-in configuration is unavailable.');
  const data = object(body);
  if (data.apiVersion !== '1') throw new SafeError('API_VERSION_UNSUPPORTED', 'This plugin requires EncBird API version 1.');
  return validateOAuth(data.oauth, base);
}
