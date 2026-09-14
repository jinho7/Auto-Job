/** 글자수 세는 방식: 공백 포함 / 공백 제외 / 바이트(한글 2바이트) */
export type CountUnit = 'chars' | 'chars_no_space' | 'bytes';

export type EssayQuestion = {
  id: number;
  question: string;
  maxChars?: number;
  minChars?: number;
  unit: CountUnit;
  /** 지원서 페이지의 입력칸 번호 (브라우저에서 추출했을 때) */
  ref?: string;
  /** 선택 문항 등 참고 */
  note?: string;
};

export type EssayAnswer = { id: number; text: string };

export type Research = {
  company_summary: string;
  values: string[];
  recent: string[];
  role: string;
  sources: string[];
};

export type Strategy = { id: number; intent: string; stories: string[]; angle: string };
