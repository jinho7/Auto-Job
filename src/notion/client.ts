// 최소한의 Notion API 클라이언트 (API 버전 2026-03-11: database 안에 data source 가 있는 구조, 페이지 템플릿 지원)
export const NOTION_VERSION = '2026-03-11';

export class NotionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'NotionError';
  }
}

const HINTS: Record<number, string> = {
  401: '토큰이 올바르지 않습니다. Notion 연결(integration) 페이지에서 토큰을 다시 복사해 주세요.',
  403: '이 연결에 권한이 없습니다. 연결의 기능(읽기/쓰기/삽입) 설정을 확인해 주세요.',
  404: '찾을 수 없습니다. 해당 페이지의 ••• 메뉴 → 연결(Connections)에서 이 연결을 추가했는지 확인해 주세요.',
  429: 'Notion 요청 한도를 넘었습니다. 잠시 후 다시 시도해 주세요.',
};

type RichText = { plain_text: string }[];
export type NotionProperty = {
  id: string;
  name: string;
  type: string;
  select?: { options: { name: string }[] };
  multi_select?: { options: { name: string }[] };
  status?: { options: { name: string }[] };
};
export type DataSource = { id: string; title: string; databaseId?: string; properties: Record<string, NotionProperty> };

const plain = (t?: RichText) => (t ?? []).map((x) => x.plain_text).join('');

export class NotionClient {
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch, private readonly signal?: AbortSignal) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.signal?.throwIfAborted();
    const res = await this.fetchImpl(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    if (!res.ok) {
      throw new NotionError(res.status, json.code ?? 'unknown', HINTS[res.status] ?? `Notion 오류 (${res.status}): ${json.message ?? ''}`);
    }
    return json as T;
  }

  /** 토큰 확인: 연결 이름과 워크스페이스 */
  async me(): Promise<{ name: string; workspace: string }> {
    const u = await this.req<{ name?: string; bot?: { workspace_name?: string } }>('GET', '/users/me');
    return { name: u.name ?? '(이름 없음)', workspace: u.bot?.workspace_name ?? '' };
  }

  /** 이 연결이 볼 수 있는 데이터베이스(data source) 목록 */
  async listDataSources(query = ''): Promise<DataSource[]> {
    const out: DataSource[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.req<{ results: RawDataSource[]; has_more: boolean; next_cursor: string | null }>('POST', '/search', {
        query,
        filter: { property: 'object', value: 'data_source' },
        page_size: 100,
        start_cursor: cursor,
      });
      out.push(...r.results.map(toDataSource));
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor && out.length < 500);
    return out;
  }

  async getDataSource(id: string): Promise<DataSource> {
    return toDataSource(await this.req<RawDataSource>('GET', `/data_sources/${id}`));
  }

  /** database ID 든 data source ID 든 받아서 data source 를 돌려준다 */
  async resolveDataSource(id: string): Promise<DataSource> {
    try {
      return await this.getDataSource(id);
    } catch (e) {
      if (!(e instanceof NotionError) || (e.status !== 404 && e.status !== 400)) throw e;
    }
    const db = await this.req<{ data_sources?: { id: string }[] }>('GET', `/databases/${id}`);
    const first = db.data_sources?.[0];
    if (!first) throw new NotionError(404, 'no_data_source', '이 데이터베이스에 data source 가 없습니다');
    return this.getDataSource(first.id);
  }

  /** DB 의 모든 페이지 (휴지통 제외) */
  async queryPages(dataSourceId: string, limit = 5000): Promise<NotionPage[]> {
    const out: NotionPage[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.req<{ results: NotionPage[]; has_more: boolean; next_cursor: string | null }>('POST', `/data_sources/${dataSourceId}/query`, {
        page_size: 100,
        start_cursor: cursor,
      });
      out.push(...r.results.filter((p) => !p.in_trash));
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor && out.length < limit);
    return out;
  }

  async listTemplates(dataSourceId: string): Promise<{ id: string; name: string; is_default: boolean }[]> {
    const r = await this.req<{ templates: { id: string; name: string; is_default: boolean }[] }>('GET', `/data_sources/${dataSourceId}/templates`);
    return r.templates ?? [];
  }

  async createPage(body: {
    parent: { type: 'data_source_id'; data_source_id: string };
    properties: Record<string, unknown>;
    template?: { type: 'default' } | { type: 'template_id'; template_id: string; timezone?: string };
    children?: unknown[];
  }): Promise<{ id: string; url: string }> {
    return this.req('POST', '/pages', body);
  }

  async getPage(pageId: string): Promise<NotionPage> {
    return this.req<NotionPage>('GET', `/pages/${pageId}`);
  }

  async updatePage(pageId: string, properties: Record<string, unknown>): Promise<void> {
    await this.req('PATCH', `/pages/${pageId}`, { properties });
  }

  async updateBlock(blockId: string, body: Record<string, unknown>): Promise<void> {
    await this.req('PATCH', `/blocks/${blockId}`, body);
  }

  /** 페이지(블록)의 첫 몇 개 자식 블록 */
  async listBlocks(blockId: string, pageSize = 10): Promise<{ id: string; type: string }[]> {
    const r = await this.req<{ results: { id: string; type: string }[] }>('GET', `/blocks/${blockId}/children?page_size=${pageSize}`);
    return r.results ?? [];
  }

  /** 페이지(블록)의 자식 블록 전부 */
  async listAllBlocks(blockId: string): Promise<NotionBlock[]> {
    const out: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.req<{ results: NotionBlock[]; has_more: boolean; next_cursor: string | null }>(
        'GET',
        `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`,
      );
      out.push(...r.results);
      cursor = r.has_more ? (r.next_cursor ?? undefined) : undefined;
    } while (cursor && out.length < 2000);
    return out;
  }

  /** 자식 블록 추가. afterBlockId 가 있으면 그 블록 바로 뒤에, 없으면 맨 끝에 (100개씩 나눠 보냄) */
  async appendBlocks(parentId: string, children: unknown[], afterBlockId?: string): Promise<NotionBlock[]> {
    let after = afterBlockId;
    const added: NotionBlock[] = [];
    for (let i = 0; i < children.length; i += 100) {
      const chunk = children.slice(i, i + 100);
      const r = await this.req<{ results: NotionBlock[] }>('PATCH', `/blocks/${parentId}/children`, {
        children: chunk,
        ...(after ? { position: { type: 'after_block', after_block: { id: after } } } : {}),
      });
      added.push(...(r.results ?? []));
      if (after) after = r.results?.at(-1)?.id ?? after; // 다음 묶음은 방금 넣은 마지막 블록 뒤에
    }
    return added;
  }

  /** 이 연결이 볼 수 있는 페이지 (새 DB 를 만들 위치 고르기용) */
  async searchPages(query = ''): Promise<{ id: string; title: string; url: string }[]> {
    const r = await this.req<{ results: NotionPage[] }>('POST', '/search', { query, filter: { property: 'object', value: 'page' }, page_size: 50 });
    return r.results
      .filter((p) => p.parent?.type !== 'data_source_id' && p.parent?.type !== 'database_id') // DB 안의 행은 제외
      .map((p) => ({ id: p.id, title: pageTitle(p) || '(제목 없음)', url: p.url }));
  }

  async createDatabase(parentPageId: string, title: string, properties: Record<string, unknown>): Promise<{ databaseId: string; dataSourceId: string; url: string }> {
    const r = await this.req<{ id: string; url: string; data_sources?: { id: string }[] }>('POST', '/databases', {
      parent: { type: 'page_id', page_id: parentPageId },
      title: [{ type: 'text', text: { content: title } }],
      initial_data_source: { properties },
    });
    const dataSourceId = r.data_sources?.[0]?.id;
    if (!dataSourceId) throw new NotionError(500, 'no_data_source', 'DB는 만들었지만 data source ID를 받지 못했습니다');
    return { databaseId: r.id, dataSourceId, url: r.url };
  }
}

export type PropertyValue = {
  type: string;
  title?: RichText;
  rich_text?: RichText;
  url?: string | null;
  date?: { start: string; end?: string | null } | null;
  select?: { name: string } | null;
  multi_select?: { name: string }[];
  status?: { name: string } | null;
};
export type NotionBlock = { id: string; type: string; has_children?: boolean } & Record<string, unknown>;

/** 블록의 글자 (문단, 제목, 목록 등) */
export function blockText(b: NotionBlock): string {
  const body = b[b.type] as { rich_text?: RichText } | undefined;
  return plain(body?.rich_text).trim();
}

export type NotionPage = {
  id: string;
  url: string;
  in_trash?: boolean;
  parent?: { type: string; data_source_id?: string; database_id?: string };
  properties: Record<string, PropertyValue>;
};

export function pageTitle(p: NotionPage): string {
  const t = Object.values(p.properties ?? {}).find((v) => v.type === 'title');
  return plain(t?.title);
}

/** 속성 값을 문자열 하나로 (중복 비교, 목록 표시용) */
export function propText(v?: PropertyValue): string {
  if (!v) return '';
  switch (v.type) {
    case 'title':
      return plain(v.title);
    case 'rich_text':
      return plain(v.rich_text);
    case 'url':
      return v.url ?? '';
    case 'date':
      return v.date?.start ?? '';
    case 'select':
      return v.select?.name ?? '';
    case 'status':
      return v.status?.name ?? '';
    case 'multi_select':
      return (v.multi_select ?? []).map((o) => o.name).join(', ');
    default:
      return '';
  }
}

type RawDataSource = {
  id: string;
  title?: RichText;
  parent?: { type: string; database_id?: string };
  properties?: Record<string, NotionProperty>;
};

function toDataSource(r: RawDataSource): DataSource {
  return {
    id: r.id,
    title: plain(r.title) || '(제목 없음)',
    databaseId: r.parent?.type === 'database_id' ? r.parent.database_id : undefined,
    properties: r.properties ?? {},
  };
}
