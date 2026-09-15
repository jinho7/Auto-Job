// API 키로 AI 를 쓸 때의 대화 반복: AI 가 도구를 부르면 우리가 실행해 결과를 돌려주고, 끝날 때까지 반복한다.
//  - Anthropic: 공식 SDK(@anthropic-ai/sdk). 웹 검색/가져오기는 서버 도구(web_search, web_fetch), 브라우저는 우리 MCP 도구
//  - OpenAI Responses API: 웹 검색은 web_search 도구, 브라우저는 function 도구
import Anthropic from '@anthropic-ai/sdk';
import type { AgentResult, AgentRun } from './claude-cli';
import { connectMcp, type ToolHost } from './tool-host';

export type ApiProvider = 'anthropic' | 'openai';
export type ApiDeps = {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** 테스트에서 MCP 서버 대신 쓸 도구 */
  host?: ToolHost;
  maxTurns?: number;
};

const WEB = new Set(['WebSearch', 'WebFetch']);

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
    const text = await res.text();
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1) ** 2));
      continue;
    }
    if (!res.ok) throw new Error(`AI API 요청 실패 (${res.status}): ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

const toolText = (out: { text: string; isError: boolean }) => (out.isError ? `실패: ${out.text}` : out.text || '(결과 없음)');

/** Opus 5 / Sonnet 5 / Fable 등 최신 모델: 새 웹 도구(동적 필터링)와 서버 쪽 거절 대체(fallbacks)를 쓴다 */
const MODERN = /^claude-(opus-5|sonnet-5|fable|mythos|opus-4-[678]|sonnet-4-6)/;
const FALLBACK = /^claude-(opus-5|fable-5-1)/;

async function runAnthropic(o: AgentRun, d: ApiDeps, host: ToolHost | null, f: typeof fetch): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: d.apiKey, fetch: f, maxRetries: 3 });
  const web = (o.tools ?? []).some((t) => WEB.has(t));
  const modern = MODERN.test(d.model);
  const tools: unknown[] = [
    ...(web
      ? modern
        ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 20 }, { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 20 }]
        : [{ type: 'web_search_20250305', name: 'web_search', max_uses: 20 }, { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 20 }]
      : []),
    ...(host?.tools ?? []).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  ];
  const betas = [...(FALLBACK.test(d.model) ? ['server-side-fallback-2026-07-01'] : []), ...(web && !modern ? ['web-fetch-2025-09-10'] : [])];
  // Haiku 는 추론 성능(effort)을 받지 않는다
  const effort = o.effort && !/haiku/.test(d.model) ? { output_config: { effort: o.effort } } : {};
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: o.prompt }];
  let last = '';
  for (let turn = 0; turn < (d.maxTurns ?? 150); turn++) {
    const params = { model: d.model, max_tokens: 16000, system: o.systemAppend, messages, ...(tools.length ? { tools } : {}), ...effort };
    // 거절(refusal)되면 서버가 알아서 다른 모델로 이어서 답하게 한다 (Opus 5 / Fable 5.1)
    const r = (betas.length
      ? await client.beta.messages.create({ ...params, betas, ...(FALLBACK.test(d.model) ? { fallbacks: 'default' } : {}) } as never, { signal: o.signal })
      : await client.messages.create(params as never, { signal: o.signal })) as unknown as { content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string };
    const content = r.content ?? [];
    messages.push({ role: 'assistant', content });
    const texts = content.filter((c) => c.type === 'text' && c.text?.trim()).map((c) => c.text!);
    for (const t of texts) o.onEvent?.({ type: 'text', text: t });
    if (texts.length) last = texts.join('\n');
    for (const c of content) if (c.type === 'server_tool_use') o.onEvent?.({ type: 'tool', name: String(c.name), input: c.input ?? {} });
    if (r.stop_reason === 'pause_turn') continue; // 서버 도구(웹 검색)가 길어져 잠시 멈춤 → 그대로 이어서
    if (r.stop_reason !== 'tool_use') return { text: last, isError: r.stop_reason === 'refusal' };
    const results: unknown[] = [];
    for (const c of content.filter((x) => x.type === 'tool_use')) {
      o.onEvent?.({ type: 'tool', name: String(c.name), input: c.input ?? {} });
      const out = host ? await host.call(String(c.name), c.input ?? {}) : { text: '도구가 없습니다', images: [], isError: true };
      results.push({
        type: 'tool_result',
        tool_use_id: c.id,
        is_error: out.isError,
        content: [{ type: 'text', text: toolText(out) }, ...out.images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mimeType, data: im.data } }))],
      });
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: `대화가 너무 길어져 멈췄습니다. 마지막 응답: ${last}`, isError: true };
}

async function runOpenAi(o: AgentRun, d: ApiDeps, host: ToolHost | null, f: typeof fetch): Promise<AgentResult> {
  const web = (o.tools ?? []).some((t) => WEB.has(t));
  const tools: unknown[] = [
    ...(web ? [{ type: 'web_search' }] : []),
    ...(host?.tools ?? []).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema })),
  ];
  const headers = { authorization: `Bearer ${d.apiKey}` };
  let input: unknown[] = [{ role: 'user', content: o.prompt }];
  let previous: string | undefined;
  let last = '';
  for (let turn = 0; turn < (d.maxTurns ?? 150); turn++) {
    const reasoning = o.effort ? { reasoning: { effort: o.effort === 'xhigh' || o.effort === 'max' ? 'high' : o.effort } } : {};
    const r = await post(f, 'https://api.openai.com/v1/responses', headers, { model: d.model, instructions: o.systemAppend, input, ...(previous ? { previous_response_id: previous } : {}), ...(tools.length ? { tools } : {}), ...reasoning }, o.signal);
    previous = r.id;
    const output = (r.output ?? []) as { type: string; name?: string; arguments?: string; call_id?: string; content?: { type: string; text?: string }[]; action?: { query?: string } }[];
    const texts = output.filter((x) => x.type === 'message').flatMap((m) => (m.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? ''));
    for (const t of texts.filter((x) => x.trim())) o.onEvent?.({ type: 'text', text: t });
    if (texts.length) last = texts.join('\n');
    for (const x of output) if (x.type === 'web_search_call') o.onEvent?.({ type: 'tool', name: 'web_search', input: { query: x.action?.query } });
    const calls = output.filter((x) => x.type === 'function_call');
    if (!calls.length) return { text: last, isError: r.status === 'failed' || (r.status === 'incomplete' && !last) };
    input = [];
    const images: unknown[] = [];
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.arguments || '{}');
      } catch {
        /* 빈 인자로 */
      }
      o.onEvent?.({ type: 'tool', name: String(c.name), input: args });
      const out = host ? await host.call(String(c.name), args) : { text: '도구가 없습니다', images: [], isError: true };
      input.push({ type: 'function_call_output', call_id: c.call_id, output: toolText(out) + (out.images.length ? '\n(화면 이미지는 다음 메시지에 붙였습니다)' : '') });
      for (const im of out.images) images.push({ type: 'input_image', image_url: `data:${im.mimeType};base64,${im.data}` });
    }
    if (images.length) input.push({ role: 'user', content: images });
  }
  return { text: `대화가 너무 길어져 멈췄습니다. 마지막 응답: ${last}`, isError: true };
}

export async function runApiAgent(provider: ApiProvider, o: AgentRun, d: ApiDeps): Promise<AgentResult> {
  if (!d.apiKey) throw new Error(`${provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} 가 없습니다. 설정 → AI 연결에서 API 키를 넣어 주세요.`);
  if (!d.model) throw new Error('AI 모델 이름이 없습니다. 설정 → AI 연결에서 모델을 정해 주세요.');
  const f = d.fetchImpl ?? fetch;
  let host = d.host ?? null;
  const own = !host && o.mcp;
  if (own) {
    try {
      host = await connectMcp(o.mcp!);
    } catch (e) {
      throw new Error(`${o.mcp!.server} MCP 서버에 연결하지 못했습니다: ${(e as Error).message}`);
    }
  }
  try {
    const r = provider === 'anthropic' ? await runAnthropic(o, d, host, f) : await runOpenAi(o, d, host, f);
    o.onEvent?.({ type: 'result', text: r.text, isError: r.isError });
    return r;
  } finally {
    if (own) await host?.close().catch(() => {});
  }
}
