// autojob-browser MCP 서버: AI 가 지원서 페이지를 다룰 수 있는 유일한 통로.
// 환경 변수: AUTOJOB_TARGET_ID(지원서 탭), AUTOJOB_BRIDGE_URL / AUTOJOB_BRIDGE_TOKEN, AUTOJOB_HOME
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import pkg from '../../package.json' with { type: 'json' };
import { ApplyTools, ToolError } from '../apply/tools';
import { BridgeClient } from '../apply/bridge';
import { loadSettings } from '../config';
import { paths } from '../paths';

type Args = Record<string, unknown>;
type Tool = { description: string; props?: Record<string, Record<string, unknown>>; required?: string[]; run: (a: Args) => Promise<string | { image: Buffer }> };

export async function main(): Promise<void> {
  const settings = loadSettings();
  const driver = settings.browser.driver === 'handoff' ? 'aside' : settings.browser.driver;
  // Claude 는 MCP 서버 연결을 기다리지 않고 시작하므로, 시작은 바로 응답하고 브라우저 연결은 처음 도구를 부를 때 한다.
  // (연결을 미리 걸어 두되, 도구 호출에서 끝나기를 기다린다)
  const toolsReady = ApplyTools.connect(settings, settings.browser[driver].cdp_port, process.env.AUTOJOB_TARGET_ID ?? '', path.join(paths.profileMe, 'files'), {
    background: process.env.AUTOJOB_BACKGROUND === '1',
  });
  toolsReady.catch(() => {});
  let toolsCache: ApplyTools | null = null;
  const tools = new Proxy({} as ApplyTools, {
    get: (_, prop) => {
      if (!toolsCache) throw new ToolError('브라우저에 아직 연결 중입니다. 잠시 후 다시 시도하세요.');
      const v = (toolsCache as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(toolsCache) : v;
    },
  });
  const bridge = new BridgeClient(process.env.AUTOJOB_BRIDGE_URL ?? '', process.env.AUTOJOB_BRIDGE_TOKEN ?? '');
  const str = (a: Args, k: string) => {
    if (typeof a[k] !== 'string' || a[k] === '') throw new ToolError(`${k} 가 필요합니다`);
    return a[k] as string;
  };
  const report = async (msg: string, tool: string) => {
    const last = tools.log.at(-1);
    if (last && last.tool === tool) await bridge.event({ type: 'action', tool, label: last.label, value: last.value, ok: last.ok, message: last.message });
    return msg;
  };
  const ref = { type: 'string', description: 'snapshot 에 나온 [f0-12] 같은 번호 (대괄호 없이)' };

  const TOOLS: Record<string, Tool> = {
    snapshot: { description: '현재 창의 입력칸과 버튼 목록 (번호, 라벨, 현재 값, 선택지). 화면이 바뀌면 다시 보세요.', run: () => tools.snapshot() },
    screenshot: { description: '현재 창의 화면 이미지. 배치나 팝업 모양을 봐야 할 때만 쓰세요.', run: async () => ({ image: await tools.screenshot() }) },
    page_text: { description: '현재 창의 보이는 글 전체. 문항 글이나 글자수 안내처럼 입력칸 라벨이 아닌 글을 읽을 때 씁니다.', run: () => tools.pageText() },
    fill: {
      description: '빈 칸에 글자를 넣습니다. 이미 값이 있는 칸은 바꾸지 않습니다. 날짜는 칸의 placeholder 형식에 맞춰 넣으세요.',
      props: { ref, value: { type: 'string', description: '넣을 값' } },
      required: ['ref', 'value'],
      run: (a) => tools.fill(str(a, 'ref'), String(a.value ?? '')).then((m) => report(m, 'fill')),
    },
    type_slowly: {
      description: '한 글자씩 입력합니다. fill 로 넣었는데 사이트가 값을 지우거나 이상하게 바꿀 때만 쓰세요.',
      props: { ref, value: { type: 'string', description: '넣을 값' } },
      required: ['ref', 'value'],
      run: (a) => tools.fill(str(a, 'ref'), String(a.value ?? ''), { typeSlowly: true }).then((m) => report(m, 'fill')),
    },
    select: {
      description: 'select 에서 선택지를 고릅니다 (선택지 글자 그대로). 이미 다른 값이 선택되어 있으면 바꾸지 않습니다.',
      props: { ref, option: { type: 'string', description: '선택지 글자' } },
      required: ['ref', 'option'],
      run: (a) => tools.select(str(a, 'ref'), str(a, 'option')).then((m) => report(m, 'select')),
    },
    check: {
      description: '라디오/체크박스를 선택합니다. 이미 선택된 것을 해제하지는 않습니다.',
      props: { ref },
      required: ['ref'],
      run: (a) => tools.check(str(a, 'ref'), true).then((m) => report(m, 'check')),
    },
    click: {
      description: '버튼/링크/탭을 누릅니다 (행 추가, 주소 검색, 탭 이동 등). 제출·작성완료·삭제·로그아웃·작성취소와 페이지를 떠나는 링크는 막혀 있습니다.',
      props: { ref },
      required: ['ref'],
      run: (a) => tools.click(str(a, 'ref')).then((m) => report(m, 'click')),
    },
    press: {
      description: '입력칸에서 키를 누릅니다 (Enter, Tab, Escape, 방향키, Space). 예: 주소 검색창에서 Enter.',
      props: { ref, key: { type: 'string', description: 'Enter | Tab | Escape | ArrowDown | ArrowUp | ArrowLeft | ArrowRight | Space' } },
      required: ['ref', 'key'],
      run: (a) => tools.press(str(a, 'ref'), str(a, 'key')).then((m) => report(m, 'press')),
    },
    upload: {
      description: '파일 입력칸에 내 파일(profile/me/files 안, 예: 증명사진)을 올립니다.',
      props: { ref, file: { type: 'string', description: '파일 이름' } },
      required: ['ref', 'file'],
      run: (a) => tools.upload(str(a, 'ref'), str(a, 'file')).then((m) => report(m, 'upload')),
    },
    pages: { description: '열린 창 목록 (지원서 + 팝업).', run: async () => tools.pages() },
    use_page: {
      description: '다른 창(팝업 등)으로 전환합니다. 팝업이 닫히면 자동으로 지원서 창으로 돌아옵니다.',
      props: { index: { type: 'number', description: 'pages 의 번호' } },
      required: ['index'],
      run: async (a) => tools.usePage(Number(a.index)),
    },
    wait: { description: '잠시 기다립니다 (최대 5초).', props: { ms: { type: 'number', description: '밀리초' } }, run: (a) => tools.wait(Number(a.ms ?? 1000)) },
    blank: {
      description: '내 정보에 값이 없어서(또는 맞는 선택지가 없어서) 비워 둔 칸을 기록합니다. 비워 둔 칸마다 꼭 호출하세요.',
      props: { field: { type: 'string', description: '사이트의 칸 이름' }, reason: { type: 'string', description: '비운 이유' } },
      required: ['field', 'reason'],
      run: async (a) => (await bridge.event({ type: 'blank', field: str(a, 'field'), reason: String(a.reason ?? '') }), '기록했습니다.'),
    },
    note: {
      description: '사용자가 확인해야 할 참고사항을 기록합니다 (애매했던 판단, 파일 업로드 필요 등).',
      props: { text: { type: 'string', description: '내용' } },
      required: ['text'],
      run: async (a) => (await bridge.event({ type: 'note', text: str(a, 'text') }), '기록했습니다.'),
    },
    ask_user: {
      description: '사람만 할 수 있는 일(로그인, 본인인증, CAPTCHA, 약관 동의)이나 정말 판단이 안 되는 것을 사용자에게 묻고 답을 기다립니다.',
      props: { question: { type: 'string', description: '질문' } },
      required: ['question'],
      run: async (a) => `사용자 답: ${await bridge.ask(str(a, 'question'))}`,
    },
    set_questions: {
      description: '찾은 자기소개서 문항을 기록합니다 (문항 찾기 단계에서만). questions 는 [{id, ref, question, maxChars, minChars, unit(chars|chars_no_space|bytes), note}] 입니다.',
      props: {
        role: { type: 'string', description: '지원 직무명 (페이지에 보이면)' },
        questions: { type: 'array', description: '문항 목록', items: { type: 'object' } },
      },
      required: ['questions'],
      run: async (a) => {
        if (!Array.isArray(a.questions) || !a.questions.length) throw new ToolError('questions 에 문항이 하나 이상 있어야 합니다');
        for (const q of a.questions as Record<string, unknown>[]) {
          if (typeof q.question !== 'string' || !q.question.trim()) throw new ToolError('문항마다 question 글이 필요합니다');
          if (typeof q.ref !== 'string' || !q.ref) throw new ToolError('문항마다 답을 넣을 입력칸 ref 가 필요합니다');
        }
        await bridge.event({ type: 'questions', role: String(a.role ?? ''), questions: a.questions as unknown[] });
        return `문항 ${a.questions.length}개를 기록했습니다.`;
      },
    },
    set_form_info: {
      description: '지원서 구성 정보를 기록합니다 (문항 찾기 단계에서). projects: 프로젝트/동아리/활동 입력란이 있는지와 무엇이 들어 있는지, documents: 올려야 할 제출 서류(포트폴리오, 증명서 등)와 올렸는지, procedure: 페이지에 보이는 전형 절차.',
      props: {
        projects: { type: 'array', description: '예: ["프로젝트 입력란 있음 (최대 3개) — 1개 입력됨", "동아리 입력란 없음"]', items: { type: 'string' } },
        documents: { type: 'array', description: '예: ["포트폴리오 (선택) — 올리지 않음", "증명사진 (필수) — 올림"]', items: { type: 'string' } },
        procedure: { type: 'array', description: '예: ["서류전형", "코딩테스트", "1차 면접"]', items: { type: 'string' } },
      },
      run: async (a) => {
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((x) => x.trim()) : []);
        await bridge.event({ type: 'form_info', projects: list(a.projects), documents: list(a.documents), procedure: list(a.procedure) });
        return '기록했습니다.';
      },
    },
    finish: {
      description: '입력을 모두 마쳤을 때 호출합니다. 요약을 남기면 끝납니다.',
      props: { summary: { type: 'string', description: '무엇을 입력했는지 요약' } },
      required: ['summary'],
      run: async (a) => (await bridge.event({ type: 'finish', summary: str(a, 'summary') }), '완료를 기록했습니다. 이제 멈추세요.'),
    },
  };

  const server = new Server({ name: 'autojob-browser', version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: { type: 'object' as const, properties: t.props ?? {}, required: t.required ?? [] },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = TOOLS[req.params.name];
    if (!t) return { content: [{ type: 'text', text: `없는 도구: ${req.params.name}` }], isError: true };
    try {
      toolsCache ??= await toolsReady;
      const out = await t.run((req.params.arguments ?? {}) as Args);
      if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
      return { content: [{ type: 'image', data: out.image.toString('base64'), mimeType: 'image/jpeg' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `실패: ${(e as Error).message}` }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    await toolsCache?.close().catch(() => {});
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`autojob-browser MCP 시작 실패: ${(e as Error).message}\n`);
  process.exit(1);
});
