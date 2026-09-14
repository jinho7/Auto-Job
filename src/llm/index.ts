// AI 연결 방식 고르기: 설정의 llm.backend 에 따라 같은 모양(RunAgent)으로 부른다.
//  claude-cli    Claude Code (claude -p) — Claude 구독 / 로그인
//  codex-cli     Codex CLI (codex exec) — ChatGPT 구독 / 로그인
//  anthropic-api Anthropic API 키
//  openai-api    OpenAI API 키
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Settings } from '../config';
import { getSecret } from '../secrets';
import { runApiAgent } from './api-agent';
import { runClaudeAgent, type AgentRun, type RunAgent } from './claude-cli';
import { runCodexAgent } from './codex-cli';

export type { AgentRun, RunAgent } from './claude-cli';

export const BACKEND_LABEL: Record<Settings['llm']['backend'], string> = {
  'claude-cli': 'Claude Code (claude -p)',
  'codex-cli': 'Codex CLI (codex exec)',
  'anthropic-api': 'Anthropic API',
  'openai-api': 'OpenAI API',
};

/** API 방식에서 모델을 비워 두면 쓰는 기본 모델 */
export const DEFAULT_API_MODEL = { 'anthropic-api': 'claude-sonnet-5', 'openai-api': 'gpt-5' } as const;

/** 기능별 모델(예: essay.model) → 없으면 AI 연결의 모델 → 없으면 방식별 기본 */
export function modelFor(settings: Settings, featureModel?: string): string | undefined {
  const b = settings.llm.backend;
  const m = featureModel || settings.llm.model || (b === 'anthropic-api' || b === 'openai-api' ? DEFAULT_API_MODEL[b] : '');
  return m || undefined;
}

export function agentFor(settings: Settings): RunAgent {
  const b = settings.llm.backend;
  return (o: AgentRun) => {
    const run = { ...o, model: o.model || modelFor(settings) };
    switch (b) {
      case 'claude-cli':
        return runClaudeAgent(run);
      case 'codex-cli':
        return runCodexAgent(run);
      case 'anthropic-api':
        return runApiAgent('anthropic', run, { apiKey: getSecret('ANTHROPIC_API_KEY') ?? '', model: run.model ?? '' });
      case 'openai-api':
        return runApiAgent('openai', run, { apiKey: getSecret('OPENAI_API_KEY') ?? '', model: run.model ?? '' });
    }
  };
}

/** 연결 확인: 도구 없이 짧은 답을 받아 본다 (로그인, API 키, 모델 이름 확인) */
export async function testAi(settings: Settings, runAgent: RunAgent = agentFor(settings)): Promise<{ ok: boolean; message: string; ms: number }> {
  const t0 = Date.now();
  const dir = mkdtempSync(path.join(tmpdir(), 'autojob-ai-'));
  try {
    const r = await runAgent({ prompt: '연결 확인입니다. "연결됨" 이라고만 답하세요.', systemAppend: '짧게 답합니다.', tools: [], cwd: dir });
    const ms = Date.now() - t0;
    if (r.isError) return { ok: false, message: r.text.slice(0, 300), ms };
    return { ok: true, message: `${BACKEND_LABEL[settings.llm.backend]}${modelFor(settings) ? ` (${modelFor(settings)})` : ''} 응답: ${r.text.trim().slice(0, 60)}`, ms };
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 300), ms: Date.now() - t0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
