import { same } from './files.mjs';

export function classifyAttempt(testCase, phase, name, input, prior = []) {
  if (name === 'read_guidance') {
    const allowed = ['SKILL.md', ...testCase.guidance];
    if (!input || !allowed.includes(input.path)) return { allowed: false, code: 'GUIDANCE_OUT_OF_SCOPE' };
    if (prior.filter(event => event.name === name).length >= 12) return { allowed: false, code: 'GUIDANCE_CALL_LIMIT' };
    return { allowed: true, guidance: input.path };
  }
  const index = phase.rules.findIndex(rule => rule.tool === name && same(rule.input, input));
  if (index < 0) return { allowed: false, code: 'NOT_AUTHORIZED_BY_USER_PHASE' };
  const rule = phase.rules[index];
  const previous = prior.filter(event => event.name === name && same(event.input, input));
  if (previous.length >= rule.max) return { allowed: false, code: 'REPEATED_OR_UNAUTHORIZED_RETRY' };
  return { allowed: true, ruleIndex: index };
}

