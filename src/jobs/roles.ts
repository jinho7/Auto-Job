// 직무 태그 판정: 설정의 규칙(태그 → 단어), 규칙이 없는 태그는 태그 이름의 단어로 공고 제목/직무명을 본다.
const STOP = new Set(['개발자', '개발', '엔지니어', '담당', '담당자', '직무', '기타', '분야']);

/** "백엔드 (서버)" → [백엔드, 서버], "클라우드/인프라" → [클라우드, 인프라], "FEP 개발자" → [FEP] */
export function tagTokens(tag: string): string[] {
  return tag
    .split(/[\s/(),·|]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function textHas(text: string, word: string): boolean {
  const w = word.trim();
  if (!w) return false;
  if (/^[A-Za-z0-9&+#.]+$/.test(w)) {
    // 짧은 영문(AI, IT, SRE)은 다른 영단어 속 글자와 헷갈리지 않게
    const esc = w.replace(/[.+#&]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z])${esc}([^A-Za-z]|$)`, 'i').test(text);
  }
  return text.replace(/\s+/g, '').toLowerCase().includes(w.replace(/\s+/g, '').toLowerCase());
}

export function keywordsForTag(tag: string, rules: Record<string, string[]>): string[] {
  return rules[tag]?.length ? rules[tag] : tagTokens(tag);
}

/** tags: DB 에 있는 직무 태그. 반환: 공고에 맞는 태그 */
export function matchRoles(tags: string[], rules: Record<string, string[]>, text: string): string[] {
  return tags.filter((tag) => keywordsForTag(tag, rules).some((w) => textHas(text, w)));
}
