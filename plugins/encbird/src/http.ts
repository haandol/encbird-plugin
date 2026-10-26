import { SafeError, uncertainOutcome } from './errors.js';
import { retryAfterSeconds } from './traffic.js';

export function serviceUrl(value: unknown): URL {
  try {
    if (typeof value !== 'string' || /[\s\x00-\x1f\x7f\\]/.test(value)) throw new Error();
    const parts = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/.exec(value);
    if (!parts || /[@%]/.test(parts[2]!)) throw new Error();
    const url = new URL(value);
    const authority = parts[2]!.toLowerCase().replace(url.protocol === 'https:' ? /:443$/ : /:80$/, '');
    if (authority !== url.host || url.pathname !== (parts[3] ?? '/') || /%(?![0-9a-f]{2})/i.test(url.pathname)) throw new Error();
    return url;
  } catch { throw new SafeError('INVALID_CONFIG', 'Service URLs must be unambiguous HTTP or HTTPS URLs without credentials, queries, or fragments.'); }
}

export async function requestJson(url: string, init: RequestInit = {}, timeoutMs = 15_000, errorBodyOptional = false): Promise<{ status: number; body: unknown; retryAfterSeconds?: number }> {
  let response!: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const pause = response.status === 429 || response.status === 503;
    const result = (body: unknown) => ({ status: response.status, body,
      ...(pause ? { retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')) } : {}) });
    if (errorBodyOptional && response.status === 401) {
      await response.body?.cancel().catch(() => {});
      return result(null);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_048_576) {
          await reader.cancel();
          if (pause || (errorBodyOptional && !response.ok)) return result({});
          throw new SafeError('INVALID_RESPONSE', `The service response exceeded the size limit. Ask the operator to repair the response before retrying. ${uncertainOutcome}`);
        }
        chunks.push(value);
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw && response.status >= 200 && response.status < 300) return { status: response.status, body: null };
    try { return result(JSON.parse(raw)); }
    catch {
      if (pause || (errorBodyOptional && !response.ok)) return result({});
      throw new SafeError('INVALID_RESPONSE', `The service returned invalid JSON. Ask the operator to restore a valid response before retrying. ${uncertainOutcome}`);
    }
  } catch (error) {
    // An overloaded server may stop sending its body after sending Retry-After.
    // Keep the pause even if reading that body fails or times out.
    if (response?.status === 429 || response?.status === 503) {
      return { status: response.status, body: {}, retryAfterSeconds: retryAfterSeconds(response.headers.get('retry-after')) };
    }
    if (error instanceof SafeError) throw error;
    throw new SafeError('NETWORK_ERROR', `The service request could not be completed securely; delivery or response receipt is uncertain. Check connectivity and ask the operator if it persists. Retry only after access is restored; no fallback was attempted. ${uncertainOutcome}`);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('INVALID_RESPONSE', `The service returned an unexpected response shape. Ask the operator to check plugin/service compatibility before retrying. ${uncertainOutcome}`);
  return value as Record<string, unknown>;
}
