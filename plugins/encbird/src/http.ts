import { SafeError } from './errors.js';

export async function requestJson(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1_048_576) { await reader.cancel(); throw new SafeError('INVALID_RESPONSE', 'EncBird returned an oversized response.'); }
        chunks.push(value);
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw && response.status >= 200 && response.status < 300) return { status: response.status, body: null };
    try { return { status: response.status, body: JSON.parse(raw) }; }
    catch { throw new SafeError('INVALID_RESPONSE', 'The service returned an invalid JSON response.'); }
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('NETWORK_ERROR', 'The service could not be reached securely. No fallback was attempted.');
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SafeError('INVALID_RESPONSE', 'The service response has an invalid shape.');
  return value as Record<string, unknown>;
}
