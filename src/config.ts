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
export const DEFAULT_SECTION_MAP = {
  procedure: '절차',
  company: '회사/조직 소개',
  role: '지원 직무',
  essays: '자기소개서 질문',
  projects: '프로젝트 및 동아리 작성 여부',
  documents: '제출 자료 여부',
};

/** 지원 페이지로 인정하지 않는 사이트 기본 목록 (커뮤니티, 블로그, 검색 결과) */
export const DEFAULT_REJECT_DOMAINS = ['cafe.naver.com', 'blog.naver.com', 'tistory.com', 'velog.io', 'brunch.co.kr', 'dcinside.com', 'instagram.com', 'facebook.com', 'youtube.com', 'google.com', 'namu.wiki'];

export const settingsSchema = z.object({
  llm: z.object({
    backend: z.enum(['claude-cli', 'codex-cli', 'anthropic-api', 'openai-api']),
    /** 기본 모델. 비우면 방식별 기본 (Claude Code / Codex 는 각자 기본, API 는 llm/index.ts 의 기본값) */
    model: z.string().default(''),
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
    /** 지원서 작성 후 채울 페이지 본문 제목 (내용 종류 → 내 템플릿의 제목) */
    section_map: z
      .object({
        procedure: z.string(),
        company: z.string(),
        role: z.string(),
        essays: z.string(),
        projects: z.string(),
        documents: z.string(),
      })
      .default(DEFAULT_SECTION_MAP),
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
    /** 잡코리아 직무 대분류 이름 (비우면 검색 키워드만으로 거른다) */
    jobkorea: z.object({ duty_categories: z.array(z.string()).default([]) }).default({ duty_categories: [] }),
    /** 원티드 직군 번호 (비우면 전체 직군에서 검색 키워드로 거른다) */
    wanted: z.object({ job_group_ids: z.array(z.coerce.number().int()).default([]) }).default({ job_group_ids: [] }),
    /** 지원 페이지를 못 찾은 공고를 AI 가 웹에서 찾는다 */
    link_search: z
      .object({
        enabled: z.boolean().default(true),
        model: z.string().default(''),
        /** 한 번 수집할 때 AI 로 찾을 최대 공고 수 (비용 제한) */
        max_per_run: z.number().int().min(0).max(200).default(20),
        /** AI 한 번에 맡길 공고 수 */
        batch_size: z.number().int().min(1).max(10).default(5),
        /** 지원 페이지로 인정하지 않을 사이트 (카페, 블로그 …) */
        reject_domains: z.array(z.string()).default(DEFAULT_REJECT_DOMAINS),
      })
      .default({ enabled: true, model: '', max_per_run: 20, batch_size: 5, reject_domains: DEFAULT_REJECT_DOMAINS }),
    /** AI 직무 태그: off(규칙만) / fill_empty(규칙으로 못 단 공고만) / review(규칙 결과를 AI 가 다시 봄) */
    ai_roles: z
      .object({ mode: z.enum(['off', 'fill_empty', 'review']).default('fill_empty'), model: z.string().default('') })
      .default({ mode: 'fill_empty', model: '' }),
    /** 직무 태그를 하나도 달지 못한 공고는 등록하지 않는다 */
    require_role: z.boolean().default(false),
  }),
  apply: z
    .object({
      /** 인적사항 입력 AI 에게 줄 추가 규칙 (기본 규칙은 prompts/fill-basic-info.md) */
      extra_rules: z.array(z.string()).default([]),
      /** 비우면 Claude Code 기본 모델 */
      model: z.string().default(''),
      /** 다 쓰고 나서 누를 임시저장 버튼 문구 (앞에 있는 것부터 찾음) */
      save_buttons: z.array(z.string()).default(['임시저장', '임시 저장', '중간저장', '저장하기', '저장']),
      /** 다 쓰고 나서 임시저장을 누를지 */
      save_draft: z.boolean().default(true),
      /** Notion 페이지 본문 정리와 제출 상태 변경을 할지 */
      update_notion: z.boolean().default(true),
    })
    .default({ extra_rules: [], model: '', save_buttons: ['임시저장', '임시 저장', '중간저장', '저장하기', '저장'], save_draft: true, update_notion: true }),
  essay: z.object({
    tone: z.string(),
    subtitle: z.boolean(),
    forbid_middle_dot: z.boolean(),
    blind: z.boolean(),
    banned_phrases: z.array(z.string()).default([]),
    /** 자기소개서를 쓸 AI 모델. 비우면 Claude Code 기본 모델 */
    model: z.string().default(''),
    /** 검토 후 고쳐 쓰기 최대 횟수 */
    max_revisions: z.number().int().min(0).max(3).default(1),
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
