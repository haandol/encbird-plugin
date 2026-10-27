import { requestJson, object } from './http.js';
import { SafeError, uncertainOutcome } from './errors.js';
import { apiError } from './api-errors.js';
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
  } catch { throw new SafeError('INVALID_ROUTE', 'The requested API route is not allowed. Discover and use the supported EncBird tools; ask the plugin operator to repair routing before retrying. Do not substitute a direct route. This call sent no request.'); }
  const { status, body: response, retryAfterSeconds } = await requestJson(url.href, {
    method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, 15_000, true);
  if (status < 200 || status >= 300) {
    let code = 'API_ERROR';
    let structuredPause: unknown;
    try {
      const detail = object(object(response).error);
      if (typeof detail.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(detail.code)) {
        code = detail.code;
        structuredPause = detail.retryAfterSeconds;
      }
    } catch { /* Use a fixed safe error. */ }
    throw apiError(status, code, retryAfterSeconds, structuredPause);
  }
  if (status === 204) return null;
  const envelope = object(response);
  if (!Object.hasOwn(envelope, 'data') || Object.hasOwn(envelope, 'error')) throw new SafeError('INVALID_RESPONSE', `EncBird returned an invalid data envelope. Ask the operator to align the plugin and service response before retrying. ${uncertainOutcome}`);
  return envelope.data;
}
