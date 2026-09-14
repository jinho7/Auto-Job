// 새 사용자용: 설정의 속성 이름으로 공고 정리 DB 를 만든다.
import type { Settings } from '../config';
import type { SettingsStore } from '../settings/store';
import type { NotionClient } from './client';

const options = (names: string[]) => ({ options: [...new Set(names.map((n) => n.trim()).filter(Boolean))].map((name) => ({ name })) });

/** roles: 직무 태그로 만들 이름 (내 정보의 희망 직무 등, 사용자가 입력한 값) */
export function bootstrapProperties(n: Settings['notion'], roles: string[]): Record<string, unknown> {
  const f = n.fields;
  const s = n.status_options;
  return {
    [f.company]: { title: {} },
    [f.roles]: { multi_select: options(roles) },
    [f.employment]: { multi_select: options(Object.values(n.employment_options)) },
    [f.deadline]: { date: {} },
    [f.status]: { select: options([s.default, s.priority, s.after_apply, '제출완료', '미제출']) },
    [f.result]: { multi_select: options([n.result_default, '서류합격', '1차면접', '2차면접', '최종합격', '불합격']) },
    [f.note]: { rich_text: {} },
    [f.link]: { url: {} },
    [f.result_date]: { date: {} },
    [f.files]: { files: {} },
  };
}

export async function bootstrapDatabase(
  client: NotionClient,
  store: SettingsStore,
  parentPageId: string,
  title: string,
  roles: string[],
): Promise<{ databaseId: string; dataSourceId: string; url: string }> {
  const created = await client.createDatabase(parentPageId, title, bootstrapProperties(store.settings.notion, roles));
  store.set('notion.database_id', created.databaseId);
  store.set('notion.data_source_id', created.dataSourceId);
  return created;
}
