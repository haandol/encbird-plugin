import { SafeError, type Secrets } from './errors.js';

// Mirrors the external-learning service's detectable sensitive-text boundary.
const unsafe = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}|https?:\/\/|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bsk-[a-z0-9_-]{12,}|-----BEGIN|\b(?:bearer|password|passwd|api[_ -]?key|secret[_ -]?key|access[_ -]?token)\s*[:= ]\s*\S+|\b\d{3}[- .]\d{3,4}[- .]\d{4}\b|\b\d{6}-[1-4]\d{6}\b|\b(?:ssn|social security|passport number|credit card|medical diagnosis)\b|주민등록|여권번호|신용카드번호|비밀번호/i;
const externalTools = new Set(['encbird_save_memory', 'encbird_correct_memory', 'encbird_delete_memory', 'encbird_save_suggested_expressions', 'encbird_save_freechat_scenarios']);
export function filterExternalInput(name: string, input: unknown, secrets: Secrets) {
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (secrets.contains(value) || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value) ||
          (externalTools.has(name) && (unsafe.test(value) || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)))) {
        throw new SafeError('PRIVACY_FILTERED', 'Remove private identifiers or credential content before sharing learning evidence. No request was sent.');
      }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(input);
}
