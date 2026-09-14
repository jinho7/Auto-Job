// 수집기, Notion, 지원서 작성이 함께 쓰는 공고 모델
export type JobPosting = {
  company: string;
  /** 공고 제목 (Notion 에는 속성이 없어 페이지 본문/중복 판단에만 쓴다) */
  title?: string;
  /** Notion 직무 태그 (기존 옵션 이름) */
  roles: string[];
  /** 표준 채용 분류 키: 정규직 / 채용연계형인턴 / 체험형인턴 / 계약직 (settings.notion.employment_options 의 키) */
  employment: string[];
  /** 마감. 상시 채용이면 null */
  deadline: { date: string; time?: string } | null;
  /** 실제 지원 페이지 */
  link: string;
  note?: string;
  /** 기업 구분 (settings.company_types 의 키) */
  companyType?: string;
  source?: string;
};

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "2026-09-30", "2026.09.30 18:00", "상시" 등을 마감 값으로 */
export function parseDeadline(text: string | undefined | null): JobPosting['deadline'] {
  const t = (text ?? '').trim();
  if (!t || /상시|수시|채용\s*시/.test(t)) return null;
  const m = t.match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (!m) throw new Error(`마감일 형식을 알 수 없습니다: "${t}" (예: 2026-09-30 18:00, 상시)`);
  const pad = (s: string) => s.padStart(2, '0');
  const date = `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  const time = m[4] ? `${pad(m[4])}:${m[5]}` : undefined;
  if (time && !TIME_RE.test(time)) throw new Error(`시간 형식이 잘못됐습니다: ${time}`);
  return { date, ...(time ? { time } : {}) };
}
