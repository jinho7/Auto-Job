// 비밀값(.env) 관리. 파일은 git 에서 제외되고 권한 600 으로 저장된다.
// 환경 변수에 같은 이름이 있으면 그것이 우선한다.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { paths } from './paths';

export const SECRET_KEYS = {
  NOTION_TOKEN: 'Notion 연결 토큰',
  ANTHROPIC_API_KEY: 'Anthropic API 키',
  OPENAI_API_KEY: 'OpenAI API 키',
} as const;
/** 고정 이름 + AI 연결별 API 키 (LLM_KEY_<연결 id>) */
export type SecretKey = keyof typeof SECRET_KEYS | `LLM_KEY_${string}`;

export const connectionKeyName = (id: string): SecretKey => `LLM_KEY_${id.toUpperCase()}`;

function checkName(key: string): void {
  if (!(key in SECRET_KEYS) && !/^LLM_KEY_[A-Z0-9]+$/.test(key)) throw new Error(`알 수 없는 비밀값 이름: ${key}`);
}

function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) m.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  return m;
}

export function readSecrets(file = paths.env): Map<string, string> {
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : new Map();
}

export function getSecret(key: SecretKey, file = paths.env): string | undefined {
  return process.env[key] || readSecrets(file).get(key) || undefined;
}

/** 값을 저장한다. 빈 값이면 삭제. 다른 줄과 주석은 그대로 둔다. */
export function setSecret(key: SecretKey, value: string, file = paths.env): void {
  checkName(key);
  const v = value.trim();
  if (/[\r\n]/.test(v)) throw new Error('줄바꿈이 들어간 값은 저장할 수 없습니다');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : ['# Auto-Job 비밀값 (git 에 올라가지 않음)'];
  const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (v) {
    const line = `${key}=${v}`;
    if (idx >= 0) lines[idx] = line;
    else lines.splice(lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, line);
  } else if (idx >= 0) {
    lines.splice(idx, 1);
  }
  writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** secret_abcd…wxyz */
export function maskSecret(v: string | undefined): string {
  if (!v) return '';
  return v.length <= 10 ? '•'.repeat(v.length) : `${v.slice(0, 7)}…${v.slice(-4)}`;
}

export function secretStatus(file = paths.env): Record<keyof typeof SECRET_KEYS, { label: string; set: boolean; masked: string; fromEnv: boolean }> {
  const saved = readSecrets(file);
  return Object.fromEntries(
    (Object.keys(SECRET_KEYS) as (keyof typeof SECRET_KEYS)[]).map((k) => {
      const v = process.env[k] || saved.get(k);
      return [k, { label: SECRET_KEYS[k], set: !!v, masked: maskSecret(v), fromEnv: !!process.env[k] }];
    }),
  ) as ReturnType<typeof secretStatus>;
}
