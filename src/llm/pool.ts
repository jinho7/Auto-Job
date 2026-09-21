// AI 연결 여러 개를 돌려쓰기: 위에서부터 쓰고, 한도나 로그인 문제가 생기면 그 연결을 잠시 쉬게 하고 다음 연결로 넘어간다.
// 쉬는 상태는 data/llm-state.json 에 남겨 다음 실행에서도 건너뛴다.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../config';
import { expandHome, paths } from '../paths';

export type LlmType = Settings['llm']['backend'];
export type Connection = Settings['llm']['connections'][number];

export const TYPE_LABEL: Record<LlmType, string> = {
  'claude-cli': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'anthropic-api': 'Anthropic API',
  'openai-api': 'OpenAI API',
};

/** 연결 목록. 비어 있으면 예전 설정(backend, model) 하나로 */
export function connectionsOf(settings: Settings): Connection[] {
  const l = settings.llm;
  if (l.connections.length) return l.connections;
  return [{ id: 'default', type: l.backend, label: '', model: l.model, account_dir: '', effort: '', enabled: true }];
}

export const connectionLabel = (c: Connection) => c.label || `${TYPE_LABEL[c.type]}${c.account_dir ? ` (${path.basename(expandHome(c.account_dir))})` : ''}`;

// ─── 실패 종류 ───
export type FailureKind = 'limit' | 'auth' | 'unavailable';

/** 결과 글이나 오류 글로 실패 종류를 가린다. 넘어갈 이유가 아니면 null */
export function classifyFailure(text: string): FailureKind | null {
  if (/usage limit|hit your .*limit|limit reached|rate.?limit|quota|insufficient_quota|credit balance|too many requests|\b429\b|\b529\b|overloaded|사용량 한도/i.test(text)) return 'limit';
  if (/not logged in|please run \/login|invalid api key|invalid x-api-key|authentication|unauthorized|\b401\b|codex login|API 키를 넣어|API_KEY 가 없습니다/i.test(text)) return 'auth';
  if (/명령을 찾지 못했습니다|ENOENT|아무 반응이 없어|requires approval|승인이 필요/i.test(text)) return 'unavailable';
  return null;
}

/** "resets 3pm", "resets at 15:30", "|1757955600" 같은 표기에서 한도가 풀리는 시각 */
export function parseResetTime(text: string, now = new Date()): Date | null {
  const epoch = text.match(/\|(\d{10})\b/);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const t = new Date(now);
  t.setHours(h, Number(m[2] ?? 0), 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

// ─── 쉬는 상태 ───
export type ConnState = { until: string; kind: FailureKind; reason: string };
const stateFile = () => path.join(paths.data, 'llm-state.json');

export function readConnStates(): Record<string, ConnState> {
  try {
    return existsSync(stateFile()) ? (JSON.parse(readFileSync(stateFile(), 'utf8')) as Record<string, ConnState>) : {};
  } catch {
    return {};
  }
}

function writeConnStates(s: Record<string, ConnState>): void {
  mkdirSync(path.dirname(stateFile()), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(s, null, 1));
}

export function markConnection(id: string, kind: FailureKind, reason: string, settings: Settings, now = new Date()): ConnState {
  const minutes = kind === 'limit' ? settings.llm.cooldown_minutes : kind === 'auth' ? 10 : 30;
  const until = (kind === 'limit' && parseResetTime(reason, now)) || new Date(now.getTime() + minutes * 60_000);
  const st: ConnState = { until: until.toISOString(), kind, reason: reason.slice(0, 200) };
  writeConnStates({ ...readConnStates(), [id]: st });
  return st;
}

export function clearConnection(id: string): void {
  const s = readConnStates();
  delete s[id];
  writeConnStates(s);
}

/** 지금 쉬는 중인지 (쉬는 시간이 지났으면 아님) */
export function restingState(id: string, now = new Date()): ConnState | null {
  const s = readConnStates()[id];
  return s && new Date(s.until) > now ? s : null;
}

export const KIND_LABEL: Record<FailureKind, string> = { limit: '사용량 한도', auth: '로그인/키 문제', unavailable: '쓸 수 없음' };

// ─── 마지막 연결 확인 결과 ───
// "연결 확인"을 누른 결과를 남겨 둔다. 화면을 다시 그려도 사라지지 않게, 다음에 열어도 보이게.
export type ConnCheck = { at: string; ok: boolean; message: string; ms: number };
const checkFile = () => path.join(paths.data, 'llm-checks.json');

export function readConnChecks(): Record<string, ConnCheck> {
  try {
    return existsSync(checkFile()) ? (JSON.parse(readFileSync(checkFile(), 'utf8')) as Record<string, ConnCheck>) : {};
  } catch {
    return {};
  }
}

export function saveConnCheck(id: string, c: ConnCheck): void {
  mkdirSync(path.dirname(checkFile()), { recursive: true });
  writeFileSync(checkFile(), JSON.stringify({ ...readConnChecks(), [id]: c }, null, 1));
}
