import { requestJson, object } from './http.js';
import { SafeError } from './errors.js';

export async function apiRequest(base: string, token: string, method: string, path: string, body?: unknown) {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/.test(path)) throw new SafeError('INVALID_ROUTE', 'The requested API route is not allowed.');
  const { status, body: response } = await requestJson(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (status < 200 || status >= 300) {
    let code = 'API_ERROR';
    try { const candidate = object(object(response).error).code; if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate)) code = candidate; } catch { /* Use a fixed safe error. */ }
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
