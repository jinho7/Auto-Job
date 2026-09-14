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

const companyType = z.object({ include: z.boolean(), priority: z.boolean() });

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
  }),
  collect: z.object({
    sources: z.record(z.string(), z.boolean()),
    keywords: z.array(z.string()),
    employment_types: z.array(z.string()),
    exclude_experienced: z.boolean(),
  }),
  essay: z.object({
    tone: z.string(),
    subtitle: z.boolean(),
    forbid_middle_dot: z.boolean(),
    blind: z.boolean(),
    banned_phrases: z.array(z.string()).default([]),
  }),
  company_types: z.record(z.string(), companyType),
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
