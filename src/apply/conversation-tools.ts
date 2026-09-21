import type { BridgeHandlers, BridgeTools } from './bridge';

function failureReason(content: Awaited<ReturnType<BridgeTools['call']>>['content'], args: Record<string, unknown>): string {
  const raw = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  let reason = raw.split(/\r?\n/).find(line => /^(?:Error|TimeoutError|오류):/.test(line.trim()))?.trim() || '도구가 실패를 반환했습니다';
  const redact = (v: unknown): void => {
    if (typeof v === 'string' && v.length >= 3) reason = reason.replaceAll(v, '[입력값]');
    else if (Array.isArray(v)) v.forEach(redact);
    else if (v && typeof v === 'object') Object.values(v).forEach(redact);
  };
  redact(args);
  return reason.slice(0, 300);
}

/** App conversation/reporting only. Browser schemas and execution come from MCP. */
export function conversationTools(browser: BridgeTools, handlers: BridgeHandlers): BridgeTools {
  const extras = [
    { name: 'ask_user', description: '실행을 멈추고 사용자를 기다립니다. 로그인·본인인증·CAPTCHA·결제처럼 사용자가 직접 해야 하는 절차, 또는 사용자만 아는 사실이 없어 진행 자체가 불가능할 때만 쓰세요. 판단이 필요한 선택은 스스로 결정하고, 값이 없으면 비워 둔 뒤 blanks/note 로 남기세요.', key: 'question' },
    { name: 'note', description: '사용자가 알아야 할 참고사항을 기록합니다.', key: 'text' },
  ];
  return {
    list: () => [...browser.list(), ...extras.map(t => ({ name: t.name, description: t.description, inputSchema: { type: 'object' as const, properties: { [t.key]: { type: 'string' } }, required: [t.key], additionalProperties: false } }))],
    async call(name, args) {
      if (name === 'ask_user') return { content: [{ type: 'text', text: await handlers.ask(String(args.question ?? '')) }] };
      if (name === 'note') { handlers.event({ type: 'note', text: String(args.text ?? '') }); return { content: [{ type: 'text', text: '기록했습니다.' }] }; }
      const result = await browser.call(name, args);
      if (!['browser_snapshot', 'browser_take_screenshot', 'browser_wait_for'].includes(name)) handlers.event({ type: 'action', tool: name, ok: !result.isError, message: result.isError ? `실패 — ${failureReason(result.content, args)}` : '실행함' });
      return result;
    },
  };
}
