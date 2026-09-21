import { randomUUID } from 'node:crypto';
import { NotionClient, type NotionBlock } from '../../src/notion/client';

/** In-memory HTTP fixture; no Notion credentials or network access. */
export function notionFixture(signal?: AbortSignal) {
  const pageId = randomUUID(), headingId = randomUUID(), memoId = randomUUID();
  const block = (id: string, type: string, text: string, parent: string = pageId): NotionBlock => ({ id, type, has_children: false, parent: { type: 'page_id', page_id: parent }, [type]: { rich_text: [{ plain_text: text, type: 'text', text: { content: text } }] } });
  const tree = new Map<string, NotionBlock[]>([[pageId, [block(memoId, 'paragraph', '사용자가 직접 적은 메모'), block(headingId, 'heading_2', '자기소개서 질문')]]]);
  const requests: { method: string; path: string; body: any }[] = [];
  let properties: Record<string, unknown> = { '제출 상태': { type: 'select', select: { name: '제출전' } } };
  let fail: 'none' | 'forbidden' | 'ignore' | 'lost-response' = 'none';
  const fetchImpl: typeof fetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    const path = new URL(String(url)).pathname.replace('/v1', ''), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, path, body });
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
    if (method === 'PATCH' && fail === 'forbidden') return response({ code: 'restricted_resource' }, 403);
    if (path === `/pages/${pageId}`) {
      if (method === 'PATCH' && fail !== 'ignore') properties = { ...properties, ...Object.fromEntries(Object.entries(body.properties).map(([k, v]) => [k, { type: 'select', ...(v as object) }])) };
      return response({ id: pageId, url: `https://notion.so/${pageId}`, properties });
    }
    const children = path.match(/^\/blocks\/([^/]+)\/children$/);
    if (children) {
      const parent = children[1], values = tree.get(parent) ?? [];
      if (method === 'GET') return response({ results: values, has_more: false });
      const added = body.children.map((b: any) => block(randomUUID(), b.type, b[b.type].rich_text.map((r: any) => r.text.content).join(''), parent));
      if (fail !== 'ignore') {
        const after = body.position?.after_block?.id;
        values.splice(after ? values.findIndex(b => b.id === after) + 1 : values.length, 0, ...added); tree.set(parent, values);
      }
      if (fail === 'lost-response') { fail = 'none'; throw new Error('응답 연결 종료'); }
      return response({ results: added });
    }
    const target = [...tree.values()].flat().find(b => path === `/blocks/${b.id}`);
    if (target && method === 'PATCH') {
      if (fail !== 'ignore') target[target.type] = { rich_text: body[target.type].rich_text.map((r: any) => ({ ...r, plain_text: r.text.content })) };
      return response(target);
    }
    return response({ code: 'object_not_found' }, 404);
  };
  return { pageId, headingId, memoId, block, tree, requests, client: new NotionClient('synthetic-notion-token', fetchImpl, signal), setFailure: (f: typeof fail) => { fail = f; } };
}
