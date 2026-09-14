// Notion 연결 설정 흐름 (CLI 설정 편집기와 웹 UI 가 같이 쓴다)
import { getSecret } from '../secrets';
import type { SettingsStore } from '../settings/store';
import { NotionClient, type DataSource } from './client';
import { checkMapping, suggestedFixes, type MappingReport } from './mapping';

export const INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations';

export const SETUP_STEPS = [
  `${INTEGRATIONS_URL} 에서 "새 API 통합"을 만듭니다 (유형: 내부, 이름: Auto-Job 등).`,
  '기능에서 "콘텐츠 읽기, 업데이트, 삽입"을 켜고 "내부 통합 시크릿"(토큰)을 복사합니다.',
  '공고를 정리할 DB가 있는 Notion 페이지에서 ••• → 연결(Connections) → 방금 만든 통합을 추가합니다.',
  '복사한 토큰을 여기에 붙여넣습니다.',
];

export function notionClient(fetchImpl?: typeof fetch): NotionClient {
  const token = getSecret('NOTION_TOKEN');
  if (!token) throw new Error('Notion 토큰이 없습니다. 설정 → Notion → 연결 토큰에서 입력해 주세요.');
  return new NotionClient(token, fetchImpl);
}

export type DataSourceSummary = { id: string; title: string; databaseId?: string; propertyCount: number };

export async function listDatabases(client = notionClient()): Promise<DataSourceSummary[]> {
  const list = await client.listDataSources();
  return list.map((d) => ({ id: d.id, title: d.title, databaseId: d.databaseId, propertyCount: Object.keys(d.properties).length }));
}

/** DB 를 고르면 ID 두 개를 저장하고 속성 매칭 결과를 돌려준다 */
export async function selectDatabase(store: SettingsStore, id: string, client = notionClient()): Promise<{ ds: DataSource; report: MappingReport }> {
  const ds = await client.resolveDataSource(id);
  store.set('notion.data_source_id', ds.id);
  store.set('notion.database_id', ds.databaseId ?? '');
  return { ds, report: checkMapping(store.settings.notion, ds) };
}

export async function checkCurrent(store: SettingsStore, client = notionClient()): Promise<{ ds: DataSource; report: MappingReport }> {
  const n = store.settings.notion;
  const id = n.data_source_id || n.database_id;
  if (!id) throw new Error('아직 DB를 고르지 않았습니다.');
  const ds = await client.resolveDataSource(id);
  return { ds, report: checkMapping(n, ds) };
}

/** 이름이 달라 매칭되지 않은 속성에 제안값을 적용한다 */
export function applySuggestions(store: SettingsStore, report: MappingReport): Record<string, string> {
  const fixes = suggestedFixes(report);
  for (const [k, v] of Object.entries(fixes)) store.set(`notion.fields.${k}`, v);
  return fixes;
}
