// 자기소개서 기계 검사: 글자수, 금지 표현, 가운뎃점, 소제목, 끝맺음, 블라인드, 반복 문자.
// issues(반드시 고칠 것)와 warnings(확인 권장)로 나눈다.
import type { Settings } from '../config';
import type { CountUnit, EssayAnswer, EssayQuestion } from './types';

export function countChars(text: string, unit: CountUnit): number {
  if (unit === 'chars_no_space') return [...text.replace(/\s/g, '')].length;
  if (unit === 'bytes') return [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0);
  return [...text.replace(/\r\n/g, '\n')].length;
}

export const UNIT_LABEL: Record<CountUnit, string> = { chars: '자(공백 포함)', chars_no_space: '자(공백 제외)', bytes: '바이트' };

/** 제한이 있으면 최대의 90~100% 를 목표로 한다 (최소가 있으면 그 이상) */
export function targetRange(q: EssayQuestion): { min: number; max: number } | null {
  if (!q.maxChars) return q.minChars ? { min: q.minChars, max: Infinity } : null;
  return { min: Math.max(q.minChars ?? 0, Math.floor(q.maxChars * 0.9)), max: q.maxChars };
}

export type EssayCheck = { id: number; length: number; issues: string[]; warnings: string[] };

/** "단순한 ~가 아닌" → ~ 자리에 아무 말이나 (최대 15자), 띄어쓰기는 무시 */
const PARTICLE_PAIRS: Record<string, string> = { 을: '[을를]', 를: '[을를]', 이: '[이가]', 가: '[이가]', 은: '[은는]', 는: '[은는]', 과: '[과와]', 와: '[과와]' };

export function bannedPattern(phrase: string): RegExp | null {
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = phrase
    .trim()
    .split('~')
    .map((s, i) =>
      s
        .replace(/\s+/g, '')
        .split('')
        // "~를" 처럼 ~ 바로 뒤의 조사는 짝(을/를 등)도 같은 표현으로 본다
        .map((c, j) => (i > 0 && j === 0 && PARTICLE_PAIRS[c] ? PARTICLE_PAIRS[c] : esc(c)))
        .join('\\s*'),
    );
  if (!parts.join('').length) return null;
  return new RegExp(parts.join('[^.!?\\n]{0,15}?'));
}

export function checkEssay(q: EssayQuestion, a: EssayAnswer, essay: Settings['essay'], blindTerms: string[]): EssayCheck {
  const text = a.text.trim();
  const length = countChars(text, q.unit);
  const issues: string[] = [];
  const warnings: string[] = [];
  const unit = UNIT_LABEL[q.unit];

  if (!text) issues.push('답변이 비어 있습니다');
  if (q.maxChars && length > q.maxChars) issues.push(`글자수 초과: ${length}${unit} / 최대 ${q.maxChars}`);
  if (q.minChars && length < q.minChars) issues.push(`글자수 부족: ${length}${unit} / 최소 ${q.minChars}`);
  if (q.kind && q.kind !== 'essay') return { id: a.id, length, issues, warnings };
  const range = targetRange(q);
  if (range && q.maxChars && length <= q.maxChars && length < range.min && !(q.minChars && length < q.minChars)) {
    warnings.push(`분량이 적습니다: ${length}${unit} (최대 ${q.maxChars} 의 90% 이상 권장)`);
  }

  for (const p of essay.banned_phrases) if (bannedPattern(p)?.test(text)) issues.push(`쓰지 않을 표현: "${p}"`);
  if (essay.forbid_middle_dot && /[·ㆍ]/.test(text)) issues.push('가운뎃점(·)을 썼습니다');
  if (essay.subtitle && !/^\s*\[[^\]\n]{2,40}\]/m.test(text)) issues.push('문단 소제목 [ ] 이 없습니다');

  if (essay.tone.includes('습니다')) {
    const sentences = text.replace(/\[[^\]]*\]/g, '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 5);
    const casual = sentences.filter((s) => /(다|요|음|함|임)[.!?]$/.test(s) && !/(습니다|니다|입니다)[.!?]$/.test(s));
    if (casual.length) warnings.push(`'~습니다' 가 아닌 끝맺음 ${casual.length}문장 (예: "${casual[0].slice(-20)}")`);
  }

  if (essay.blind) {
    for (const t of blindTerms) if (t.length >= 2 && text.includes(t)) issues.push(`블라인드: 실명/학교/단체명 "${t}" 이(가) 들어 있습니다`);
  }
  const rep = text.match(/(.)\1{4,}/);
  if (rep && !/[.\-=~]/.test(rep[1])) issues.push(`같은 글자 반복: "${rep[0]}"`);
  return { id: a.id, length, issues, warnings };
}

/** 블라인드 검사에 쓸 내 정보의 고유명사 (이름, 학교, 동아리·단체) */
export function blindTermsFromProfile(profile: Record<string, any>): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v.trim().length >= 2) out.add(v.trim());
  };
  add(profile.basic?.name?.ko);
  add(profile.basic?.name?.en);
  add(profile.education?.high_school?.name);
  for (const u of profile.education?.universities ?? []) add(u?.name);
  for (const a of profile.extras?.activities ?? []) {
    add(a?.organization);
    if (a?.type === '동아리') add(a?.name);
  }
  return [...out];
}

/** "지원동기 (700자 이내)", "최소 300자 ~ 최대 1,000자", "1000byte", "공백 제외 500자" 등에서 제한을 뽑는다 */
export function parseLimit(text: string): Pick<EssayQuestion, 'maxChars' | 'minChars' | 'unit'> {
  const t = text.replace(/,(?=\d{3})/g, '');
  const unit: CountUnit = /byte|바이트/i.test(t) ? 'bytes' : /공백\s*(제외|미포함)/.test(t) ? 'chars_no_space' : 'chars';
  const range = t.match(/(\d{2,5})\s*(?:자|byte|바이트)?\s*(?:이상)?\s*[~\-–]\s*(\d{2,5})\s*(?:자|byte|바이트)/i);
  if (range) return { minChars: Number(range[1]), maxChars: Number(range[2]), unit };
  const num = (re: RegExp) => {
    const m = t.match(re);
    return m ? Number(m.slice(1).find(Boolean)) : undefined;
  };
  const U = '(?:자|byte|바이트)';
  const minChars = num(new RegExp(`최소\\s*(\\d{2,5})|(\\d{2,5})\\s*${U}\\s*이상`, 'i'));
  // "최대 …", "… 이내/이하/까지" 를 먼저 보고, 없을 때만 최소가 아닌 숫자를 최대로 본다
  let maxChars = num(new RegExp(`최대\\s*(\\d{2,5})|(\\d{2,5})\\s*${U}\\s*(?:이내|이하|내외|까지)`, 'i'));
  if (!maxChars) {
    const all = [...t.matchAll(new RegExp(`(\\d{2,5})\\s*${U}(?!\\s*이상)`, 'gi'))].map((m) => Number(m[1])).filter((v) => v !== minChars);
    maxChars = all.length ? Math.max(...all) : undefined;
  }
  return { ...(maxChars ? { maxChars } : {}), ...(minChars ? { minChars } : {}), unit };
}

/** 여러 문항을 붙여 넣은 글 → 문항 목록 (빈 줄로 구분, 번호로 시작하는 줄도 새 문항) */
export function parseQuestionsText(text: string): EssayQuestion[] {
  const blocks = text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n|\n(?=\s*(?:\d+[.)]|Q\d+[.:)]|문항\s*\d+))/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks.map((b, i) => ({ id: i + 1, question: b.replace(/\s+/g, ' '), ...parseLimit(b) }));
}
