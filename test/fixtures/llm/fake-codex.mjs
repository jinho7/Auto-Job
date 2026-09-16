#!/usr/bin/env node
// 테스트용 codex: 받은 인자와 표준 입력을 기록하고, codex exec --json 과 같은 모양의 이벤트를 낸다
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const out = args[args.indexOf('--output-last-message') + 1];
  const cwd = args[args.indexOf('--cd') + 1];
  writeFileSync(`${cwd}/fake-codex-call.json`, JSON.stringify({ args, input }));
  const ev = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  ev({ type: 'thread.started', thread_id: 't1' });
  ev({ type: 'item.started', item: { id: 'i1', type: 'mcp_tool_call', server: 'autojob', tool: 'snapshot', arguments: {} } });
  ev({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: '중간 글' } });
  if (input.includes('LIMIT')) {
    // 요즘 CLI 는 한도에 걸려도 오류로 끝내지 않고 풀릴 때까지 기다린다
    ev({ type: 'item.completed', item: { id: 'i9', type: 'agent_message', text: "You've hit your usage limit · resets at 8pm" } });
    setTimeout(() => {}, 60_000); // 기다리는 흉내
    return;
  }
  if (input.includes('SLEEP')) return void setTimeout(() => {}, 60_000); // 아무 말 없이 멈춰 있는 흉내
  if (input.includes('FAIL')) {
    ev({ type: 'turn.failed', error: { message: '한도 초과' } });
    process.exit(1);
  }
  ev({ type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: '끝 {"ok":true}' } });
  ev({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
  writeFileSync(out, '끝 {"ok":true}');
});
