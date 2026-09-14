import { existsSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { expandHome, paths } from './paths';

const cdpBrowser = z.object({
  app: z.string(),
  cdp_port: z.number().int().positive(),
  profile_dir: z.string().transform(expandHome),
});

const guard = z.object({
  always_block: z.array(z.string()).min(1),
  block_when_armed: z.array(z.string()).default([]),
  allow_exact: z.array(z.string()).default([]),
});

const companyType = z.object({
  include: z.boolean(),
  priority: z.boolean(),
  /** 이 구분으로 볼 회사명 */
  companies: z.array(z.string()).optional(),
  /** 회사명에 이 단어가 들어가면 이 구분 (예: 금융 → 은행, 증권) */
  name_keywords: z.array(z.string()).optional(),
});

/** settings.yaml 에 목록이 아예 없을 때만 쓰는 기본 목록. 설정 화면에서 자유롭게 고칠 수 있다. */
export const COMPANY_TYPE_SEEDS: Record<string, { companies: string[]; name_keywords: string[] }> = {
  유명IT: {
    companies: ['네이버', '카카오', '라인플러스', '쿠팡', '우아한형제들', '당근', '비바리퍼블리카', '토스', '야놀자', '무신사', '크래프톤', '넥슨', '엔씨소프트', '넷마블', '스마일게이트', '두나무', '컬리', '버킷플레이스', '직방', '리디', '하이퍼커넥트', '센드버드', '몰로코'],
    name_keywords: ['네이버', '카카오'],
  },
  금융: { companies: ['한국거래소', '금융결제원', '코스콤'], name_keywords: ['은행', '증권', '카드', '보험', '생명', '화재', '캐피탈', '금융', '자산운용', '저축은행'] },
  공기업: { companies: [], name_keywords: ['공사', '공단', '진흥원'] },
  대기업: { companies: [], name_keywords: ['삼성', '현대', 'SK', 'LG', '롯데', '한화', 'GS', 'CJ', '포스코', '신세계', '두산', 'HD현대', 'KT'] },
};

/** 페이지 본문 기본 제목 (settings.yaml 에 없을 때) */
export const DEFAULT_PAGE_SECTIONS = ['절차', '회사/조직 소개', '지원 직무', '자기소개서 질문', '프로젝트 및 동아리 작성 여부', '제출 자료 여부'];

export const settingsSchema = z.object({
  llm: z.object({
    backend: z.enum(['claude-cli', 'codex-cli', 'anthropic-api', 'openai-api']),
  }),
  browser: z.object({
    driver: z.enum(['aside', 'chrome', 'handoff']),
    aside: cdpBrowser,
    chrome: cdpBrowser,
    guard,
  }),
  notion: z.object({
    database_id: z.string().default(''),
    data_source_id: z.string().default(''),
    fields: z.record(z.string(), z.string()),
    employment_options: z.record(z.string(), z.string()),
    status_options: z.object({
      priority: z.string(),
      default: z.string(),
      after_apply: z.string(),
    }),
    result_default: z.string(),
    use_db_template: z.boolean().default(true),
    page_sections: z.array(z.string()).default(DEFAULT_PAGE_SECTIONS),
    timezone_offset: z.string().regex(/^[+-]\d{2}:\d{2}$/, '예: +09:00').default('+09:00'),
    /** 직무 태그 → 이 단어가 공고 제목/직무에 있으면 태그를 단다. 없는 태그는 태그 이름의 단어로 판단 */
    role_rules: z.record(z.string(), z.array(z.string())).default({}),
  }),
  collect: z.object({
    sources: z.record(z.string(), z.boolean()),
    keywords: z.array(z.string()),
    employment_types: z.array(z.string()),
    exclude_experienced: z.boolean(),
    lookahead_days: z.number().int().min(1).max(365).default(60),
    max_per_keyword: z.number().int().min(1).max(500).default(100),
    request_delay_ms: z.number().int().min(500).max(30_000).default(1500),
    jasoseol: z.object({ duty_groups: z.array(z.string()).default([]) }).default({ duty_groups: [] }),
  }),
  apply: z
    .object({
      /** 인적사항 입력 AI 에게 줄 추가 규칙 (기본 규칙은 prompts/fill-basic-info.md) */
      extra_rules: z.array(z.string()).default([]),
      /** 비우면 Claude Code 기본 모델 */
      model: z.string().default(''),
    })
    .default({ extra_rules: [], model: '' }),
  essay: z.object({
    tone: z.string(),
    subtitle: z.boolean(),
    forbid_middle_dot: z.boolean(),
    blind: z.boolean(),
    banned_phrases: z.array(z.string()).default([]),
  }),
  company_types: z.record(z.string(), companyType).transform((types) =>
    Object.fromEntries(
      Object.entries(types).map(([name, t]) => [
        name,
        {
          ...t,
          companies: t.companies ?? COMPANY_TYPE_SEEDS[name]?.companies ?? [],
          name_keywords: t.name_keywords ?? COMPANY_TYPE_SEEDS[name]?.name_keywords ?? [],
        },
      ]),
    ),
  ),
  overrides: z.object({
    always_include: z.array(z.string()).default([]),
    always_exclude: z.array(z.string()).default([]),
    priority: z.array(z.string()).default([]),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;
export type GuardConfig = Settings['browser']['guard'];
export type CdpBrowserConfig = Settings['browser']['aside'];

export function parseSettings(yamlText: string, source = 'settings'): Settings {
  const result = settingsSchema.safeParse(YAML.parse(yamlText));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`${source} 형식 오류:\n${issues}`);
  }
  return result.data;
}

/** settings.yaml을 읽는다. 없으면 settings.example.yaml로 대신하고 경고한다. */
export function loadSettings(): Settings {
  if (existsSync(paths.settings)) {
    return parseSettings(readFileSync(paths.settings, 'utf8'), 'settings.yaml');
  }
  console.warn('⚠️  settings.yaml이 없어 settings.example.yaml을 사용합니다. `autojob init`으로 만들 수 있습니다.');
  return parseSettings(readFileSync(paths.settingsExample, 'utf8'), 'settings.example.yaml');
}
