// AI 연결 고르기: 설정의 연결 목록(없으면 llm.backend 하나)을 위에서부터 쓰고, 한도나 로그인 문제가 생기면 다음 연결로 넘어간다.
//  claude-cli    Claude Code (claude -p) — Claude 구독 / 로그인. 계정 폴더(CLAUDE_CONFIG_DIR)로 여러 계정
//  codex-cli     Codex CLI (codex exec) — ChatGPT 구독 / 로그인. 계정 폴더(CODEX_HOME)로 여러 계정
//  anthropic-api Anthropic API 키
//  openai-api    OpenAI API 키
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Settings } from '../config';
import { expandHome } from '../paths';
import { connectionKeyName, getSecret } from '../secrets';
import { runApiAgent } from './api-agent';
import { runClaudeAgent, type AgentResult, type AgentRun, type RunAgent } from './claude-cli';
import { runCodexAgent } from './codex-cli';
import { classifyFailure, connectionLabel, connectionsOf, KIND_LABEL, markConnection, restingState, TYPE_LABEL, type Connection, type LlmType } from './pool';

export type { AgentRun, RunAgent } from './claude-cli';

export const BACKEND_LABEL = TYPE_LABEL;

/** API 방식에서 모델을 비워 두면 쓰는 기본 모델 */
export const DEFAULT_API_MODEL = { 'anthropic-api': 'claude-opus-5', 'openai-api': 'gpt-5' } as const;

const family = (t: LlmType) => (t === 'claude-cli' || t === 'anthropic-api' ? 'claude' : 'openai');
function modelFamily(m: string): 'claude' | 'openai' | null {
  if (/^(claude|opus|sonnet|haiku|fable)/i.test(m)) return 'claude';
  if (/^(gpt|o\d|codex|chatgpt)/i.test(m)) return 'openai';
  return null;
}

/** 이 연결에서 쓸 모델: 기능별 모델 → 연결의 모델 → AI 연결 기본 모델 → 방식별 기본.
 *  다른 회사 모델 이름(예: Codex 연결에 claude-…)은 건너뛴다 */
export function modelForConnection(settings: Settings, c: Connection, featureModel?: string): string | undefined {
  const fits = (m?: string) => !!m && (modelFamily(m) ?? family(c.type)) === family(c.type);
  const m = [featureModel, c.model, settings.llm.model].find(fits) || (c.type === 'anthropic-api' || c.type === 'openai-api' ? DEFAULT_API_MODEL[c.type] : '');
  return m || undefined;
}

/** 첫 번째 연결 기준 모델 (화면 표시용, 예전 호출 호환) */
export function modelFor(settings: Settings, featureModel?: string): string | undefined {
  return modelForConnection(settings, connectionsOf(settings)[0], featureModel);
}

export function apiKeyFor(c: Connection): string {
  return getSecret(connectionKeyName(c.id)) ?? getSecret(c.type === 'anthropic-api' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY') ?? '';
}

/** 추론 성능: 작업별 → 연결 → AI 연결 기본 */
export function effortFor(settings: Settings, c: Connection, featureEffort?: string): string | undefined {
  return featureEffort || c.effort || settings.llm.effort || undefined;
}

/** 연결 하나로 실행 */
export function runOnConnection(settings: Settings, c: Connection, o: AgentRun): Promise<AgentResult> {
  const run = { ...o, model: modelForConnection(settings, c, o.model), effort: effortFor(settings, c, o.effort), stallMs: o.stallMs ?? settings.llm.stall_minutes * 60_000 };
  const dir = c.account_dir ? path.resolve(expandHome(c.account_dir)) : '';
  switch (c.type) {
    case 'claude-cli':
      return runClaudeAgent({ ...run, env: dir ? { CLAUDE_CONFIG_DIR: dir } : undefined });
    case 'codex-cli':
      return runCodexAgent({ ...run, env: dir ? { CODEX_HOME: dir } : undefined });
    case 'anthropic-api':
      return runApiAgent('anthropic', run, { apiKey: apiKeyFor(c), model: run.model ?? '' });
    case 'openai-api':
      return runApiAgent('openai', run, { apiKey: apiKeyFor(c), model: run.model ?? '' });
  }
}

export type PoolDeps = { runOne?: (c: Connection, o: AgentRun) => Promise<AgentResult>; now?: () => Date };

/** 쉬는 중이라 건너뛴다는 말은 연결마다 한 번만 (같은 쉬는 시간 동안 매번 말하지 않게) */
const announced = new Set<string>();

/** 설정의 연결들을 돌려쓰는 AI 실행기 */
export function agentFor(settings: Settings, d: PoolDeps = {}): RunAgent {
  const runOne = d.runOne ?? ((c: Connection, o: AgentRun) => runOnConnection(settings, c, o));
  return async (o: AgentRun) => {
    const all = connectionsOf(settings).filter((c) => c.enabled);
    const skipped: string[] = [];
    const tried: string[] = [];
    for (const c of all) {
      const rest = restingState(c.id, d.now?.());
      if (rest) {
        const until = new Date(rest.until).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        skipped.push(`${connectionLabel(c)}: ${KIND_LABEL[rest.kind]} (${until}까지 쉼)`);
        const key = `${c.id}|${rest.until}`;
        if (!announced.has(key)) {
          announced.add(key);
          o.onEvent?.({ type: 'switch', from: connectionLabel(c), reason: `${KIND_LABEL[rest.kind]} — ${until}까지 쉬는 중이라 건너뜁니다` });
        }
        continue;
      }
      let r: AgentResult;
      try {
        r = await runOne(c, o);
      } catch (e) {
        const msg = (e as Error).message;
        const kind = classifyFailure(msg) ?? (/명령을 찾지 못했습니다/.test(msg) ? 'unavailable' : null);
        if (!kind) throw e;
        markConnection(c.id, kind, msg, settings, d.now?.());
        tried.push(`${connectionLabel(c)}: ${KIND_LABEL[kind]}`);
        o.onEvent?.({ type: 'switch', from: connectionLabel(c), reason: `${KIND_LABEL[kind]} — ${msg.slice(0, 80)}` });
        continue;
      }
      const kind = r.isError ? classifyFailure(r.text) : null;
      if (kind) {
        markConnection(c.id, kind, r.text, settings, d.now?.());
        tried.push(`${connectionLabel(c)}: ${KIND_LABEL[kind]}`);
        o.onEvent?.({ type: 'switch', from: connectionLabel(c), reason: `${KIND_LABEL[kind]} — ${r.text.slice(0, 80)}` });
        continue;
      }
      return { ...r, connection: connectionLabel(c) };
    }
    const why = [...tried, ...skipped];
    return { text: `쓸 수 있는 AI 연결이 없습니다${why.length ? ` — ${why.join(' / ')}` : ' (켜진 연결이 없음)'}. 설정 → AI 연결에서 연결을 추가하거나 한도가 풀릴 때까지 기다려 주세요.`, isError: true };
  };
}

/** 연결 확인은 오래 붙잡고 있지 않는다 (CLI 가 로그인·승인 같은 것을 기다리며 멈춰 있을 수 있어서) */
export const TEST_TIMEOUT_MS = 120_000;

/** 연결 확인: 도구 없이 짧은 답을 받아 본다 (로그인, API 키, 모델 이름 확인). 연결을 고르지 않으면 돌려쓰기 전체로 */
export async function testAi(settings: Settings, runAgent?: RunAgent, conn?: Connection, timeoutMs = TEST_TIMEOUT_MS): Promise<{ ok: boolean; message: string; ms: number }> {
  const t0 = Date.now();
  const dir = mkdtempSync(path.join(tmpdir(), 'autojob-ai-'));
  const run = runAgent ?? (conn ? (o: AgentRun) => runOnConnection(settings, conn, o) : agentFor(settings));
  const target = conn ?? connectionsOf(settings)[0];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await run({ prompt: '연결 확인입니다. "연결됨" 이라고만 답하세요.', systemAppend: '짧게 답합니다.', tools: [], cwd: dir, signal: ctl.signal, stallMs: timeoutMs });
    const ms = Date.now() - t0;
    if (r.isError) return { ok: false, message: r.text.slice(0, 300), ms };
    const m = modelForConnection(settings, target);
    return { ok: true, message: `${r.connection ?? connectionLabel(target)}${m ? ` (${m})` : ''} 응답: ${r.text.trim().slice(0, 60)}`, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    if (ctl.signal.aborted) {
      const how = target.type === 'codex-cli' ? 'codex exec "안녕"' : target.type === 'claude-cli' ? 'claude -p "안녕"' : '';
      return {
        ok: false,
        message: `${Math.round(timeoutMs / 1000)}초 안에 답하지 않아 그만두었습니다. ${how ? `터미널에서 \`${how}\` 를 직접 실행해 로그인이나 승인을 기다리고 있는지 확인해 주세요.` : '키와 인터넷 연결을 확인해 주세요.'}`,
        ms,
      };
    }
    return { ok: false, message: (e as Error).message.slice(0, 300), ms };
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
}
