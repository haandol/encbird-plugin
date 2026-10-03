import { setTimeout as delay } from 'node:timers/promises';
import { SafeError } from './errors.js';

// Client-side guardrails, not the service's quota. Shared through the credential lock.
export const REQUEST_INTERVAL_MS = 250;
export const REQUEST_WINDOW_MS = 60_000;
export const REQUESTS_PER_WINDOW = 60;
export interface TrafficState { recent: number[]; nextRequestAt: number; blockedUntil: number }

export function validTraffic(value: TrafficState) {
  return !!value && Array.isArray(value.recent) && value.recent.length <= REQUESTS_PER_WINDOW &&
    [...value.recent, value.nextRequestAt, value.blockedUntil].every(n => Number.isSafeInteger(n) && n >= 0);
}

export function checkRequestBudget(state?: TrafficState, now = Date.now()) {
  if (!state) return;
  if (state.blockedUntil > now) throw waitError(state.blockedUntil - now);
  const recent = state.recent.filter(time => now - time < REQUEST_WINDOW_MS);
  if (recent.length >= REQUESTS_PER_WINDOW) throw waitError(Math.min(...recent) + REQUEST_WINDOW_MS - now);
}

export async function reserveRequest(previous?: TrafficState): Promise<TrafficState> {
  let now = Date.now();
  const state = previous ?? { recent: [], nextRequestAt: 0, blockedUntil: 0 };
  checkRequestBudget(state, now);
  state.recent = state.recent.filter(time => now - time < REQUEST_WINDOW_MS);
  // Do not keep a process waiting after a clock change or a server cooldown.
  const wait = state.nextRequestAt - now;
  if (wait > REQUEST_INTERVAL_MS) throw waitError(wait);
  if (wait > 0) await delay(wait);
  now = Date.now();
  state.recent.push(now);
  state.nextRequestAt = now + REQUEST_INTERVAL_MS;
  return state;
}

function waitError(ms: number) {
  return new SafeError('REQUEST_THROTTLED', 'Wait before making another learning request. Do not poll or switch profiles to retry.', Math.max(1, Math.ceil(ms / 1000)));
}

export function retryAfterSeconds(header: string | null, now = Date.now()): number {
  if (header !== null) {
    const text = header.trim();
    const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - now) / 1000);
    if (Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(now + seconds * 1000)) return Math.max(1, seconds);
  }
  return 30;
}
