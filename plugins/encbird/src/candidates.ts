import { SafeError } from './errors.js';

interface Observation { id: string; observedAt: string }
interface Candidate extends Observation { evidenceIds?: string[] }
interface Message extends Observation { role: 'user' | 'assistant' | 'generated' }

function validObservationTime(value: string, now: number): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = match.slice(1).map(part => Number(part ?? 0));
  const leap = year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month! - 1] ?? 0;
  return month! >= 1 && month! <= 12 && day! >= 1 && day! <= days && hour! < 24 && minute! < 60 &&
    second! < 60 && zoneHour! < 24 && zoneMinute! < 60 && Date.parse(value) <= now + 300_000;
}

// The schema runs first. Only check source integrity here; the server extracts facts.
export function validateCandidateEvidence(input: Record<string, unknown>, now = Date.now()) {
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 64 * 1024) {
    throw new SafeError('INVALID_ARGUMENTS', 'Candidate input exceeds 64 KiB of UTF-8 JSON. Reduce it to relevant consented evidence before submitting; preserve actual source identities and observations. This call sent no request.');
  }
  const candidates = input.candidates as Candidate[];
  const messages = (input.messages ?? []) as Message[];

  for (const observations of [candidates, messages]) {
    const ids = new Set<string>();
    for (const item of observations) {
      if (ids.has(item.id)) throw new SafeError('INVALID_ARGUMENTS', 'Candidate or message IDs are duplicated within the input. Restore unique original IDs before submitting; do not invent new IDs to bypass an earlier conflict. This call sent no request.');
      if (!validObservationTime(item.observedAt, now)) throw new SafeError('INVALID_ARGUMENTS', 'An observation time is invalid or more than five minutes in the future. Use the actual RFC3339 observation time before submitting; never invent a time or change an earlier observation to bypass a conflict. This call sent no request.');
      ids.add(item.id);
    }
  }
  const userIds = new Set(messages.filter(message => message.role === 'user').map(message => message.id));
  for (const candidate of candidates) {
    if (candidate.evidenceIds?.some(id => !userIds.has(id))) throw new SafeError('INVALID_ARGUMENTS', 'An evidenceId does not identify a supplied actual user message. Supply the original consented user evidence or omit unsupported references before submitting; never relabel assistant or generated text as user evidence. This call sent no request.');
  }
}
