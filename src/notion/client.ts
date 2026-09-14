// 최소한의 Notion API 클라이언트 (API 버전 2025-09-03: database 안에 data source 가 있는 구조)
export const NOTION_VERSION = '2025-09-03';

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
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
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
