import { requestJson, object } from './http.js';
import { SafeError } from './errors.js';
import { validateBase } from './config.js';

export async function apiRequest(base: string, token: string, method: string, path: string, body?: unknown) {
  base = validateBase(base);
  let url: URL;
  try {
    if (!path.startsWith('/') || path.startsWith('//') || /[\s\x00-\x1f\x7f#\\]/.test(path)) throw new Error();
    url = new URL(`${base}${path}`);
    const api = new URL(base);
    const prefix = api.pathname.replace(/\/$/, '');
    if (url.origin !== api.origin || url.pathname !== `${prefix}${path.split('?')[0]}` || !url.pathname.startsWith(`${prefix}/`)) throw new Error();
  } catch { throw new SafeError('INVALID_ROUTE', 'The requested API route is not allowed.'); }
  const { status, body: response, retryAfterSeconds } = await requestJson(url.href, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (status < 200 || status >= 300) {
    let code = 'API_ERROR';
    try { const candidate = object(object(response).error).code; if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate)) code = candidate; } catch { /* Use a fixed safe error. */ }
    if (status === 429 || status === 503) throw new SafeError(code === 'API_ERROR' ? (status === 429 ? 'RATE_LIMITED' : 'SERVICE_UNAVAILABLE') : code,
      'The service requested a pause. Wait before retrying; keep the same input and operation key for writes.', retryAfterSeconds);
    if (status === 401) throw new SafeError('AUTH_REQUIRED', 'EncBird rejected this connection. Retry with the same operation key or reconnect.');
    if (status === 403 && code === 'CONNECTION_INACTIVE') throw new SafeError('CONNECTION_INACTIVE', 'This connection is inactive. Run connect for a new browser sign-in; finish any pending disconnect cleanup first.');
    if (status === 403) throw new SafeError(code === 'API_ERROR' ? 'CONNECTION_FORBIDDEN' : code, 'EncBird denied this operation for the current connection.');
    throw new SafeError(code, 'EncBird could not complete the request. If retrying a write, keep the same operation key.');
  }
  if (status === 204) return null;
  const envelope = object(response);
  if (!Object.hasOwn(envelope, 'data') || Object.hasOwn(envelope, 'error')) throw new SafeError('INVALID_RESPONSE', 'EncBird returned an invalid data envelope.');
  return envelope.data;
}
