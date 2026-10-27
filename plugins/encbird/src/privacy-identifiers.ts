const phoneCandidate = /\+?[0-9(][0-9(). -]*[0-9]/g;
const phoneLabel = /(?:\b(?:(?:phone|telephone|tel|mobile|cell(?: phone)?)(?: number)?|contact number|call me)|전화(?: *번호)?|휴대(?:폰|전화)(?: *번호)?|핸드폰(?: *번호)?|연락처)[\t\n\f\r :=]*(?:(?:is|at|on)\b|은|는)?[\t\n\f\r :=]*$/i;
const localPhone = /\(?[0-9]{2,4}\)?[ .-]+[0-9]{3,4}[ .-]+[0-9]{4}|\([0-9]{2,4}\)[ .-]*[0-9]{3,4}[ .-]+[0-9]{4}/g;
const year = '[12][0-9]{3}';
const month = '(?:0?[1-9]|1[0-2])';
const day = '(?:0?[1-9]|[12][0-9]|3[01])';
const monthName = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const date = `(?:${year}[-/. ]${month}[-/. ]${day}|${day}[-/. ]${day}[-/. ](?:${year}|[0-9]{2})` +
  `|(?:${year} *년 *)?${month} *월 *${day} *일|${monthName} +${day}(?:st|nd|rd|th)?(?:,? +${year})?` +
  `|${day}(?:st|nd|rd|th)? +(?:of +)?${monthName}(?:,? +${year})?|[0-9]{8}|[0-9]{6}|${month}[-/]${day})`;
const birthLabel = String.raw`(?:\b(?:date of birth|birth[ -]?date|d\.?o\.?b|birthday|born)\b\.?|생년월일|출생일|태어난 *날짜|생일)`;
const birthBeforeDate = new RegExp(birthLabel + String.raw`[\t\n\f\r :=]*(?:(?:is|was|on|the|falls)\b[\t\n\f\r :=]*){0,3}(?:은|는|이|가)?[\t\n\f\r ]*` + date + '(?:$|[^0-9])', 'i');
const birthAfterDate = new RegExp('(?:^|[^0-9])' + date + ` *(?:(?:is|was) +(?:my |your |the )?${birthLabel}` +
  '|(?:에 *)?(?:태어났|태어남|출생)|(?:이|가|은|는)? *(?:제 |내 )?(?:생년월일|출생일|생일)(?:$|[.!?]| *(?:입니다|이에요|이다|이야)))', 'i');

// Unicode 17 decimal digit blocks; explicit starts keep detection stable across Node ICU versions.
const decimalStarts = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6,
  0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0,
  0x1a80, 0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0,
  0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136,
  0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730,
  0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11de0, 0x11f50, 0x16130,
  0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec,
  0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

function normalize(value: string): string {
  return Array.from(value, character => {
    const point = character.codePointAt(0)!;
    if (point >= 0xff01 && point <= 0xff5e) return String.fromCodePoint(point - 0xfee0);
    const start = decimalStarts.find(start => point >= start && point < start + 10);
    if (start !== undefined) return String(point - start);
    if (/\p{Dash_Punctuation}/u.test(character) || character === '\u2212') return '-';
    if (/\p{White_Space}/u.test(character) && character !== '\n' && character !== '\r') return ' ';
    return character;
  }).join('');
}

function phoneBoundary(value: string, start: number, length: number): boolean {
  const word = /[a-zA-Z0-9_]/;
  return (start === 0 || !word.test(value[start - 1]!)) &&
    (start + length === value.length || !word.test(value[start + length]!));
}

function containsPhone(value: string): boolean {
  for (const match of value.matchAll(localPhone)) {
    if (phoneBoundary(value, match.index, match[0].length)) return true;
  }
  for (const match of value.matchAll(phoneCandidate)) {
    const number = match[0];
    const digits = number.replace(/[^0-9]/g, '').length;
    if (digits < 7) continue;
    if (phoneLabel.test(value.slice(0, match.index))) return true;
    if (digits <= 15 && phoneBoundary(value, match.index, number.length) && number.startsWith('+')) return true;
  }
  return false;
}

export function containsIdentifyingText(value: string): boolean {
  const normalized = normalize(value);
  return containsPhone(normalized) || birthBeforeDate.test(normalized) || birthAfterDate.test(normalized);
}
