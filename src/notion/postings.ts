// 지원서 작성에 고를 공고 목록 (설정 화면의 "새 지원서" 팝업)
import type { Settings } from '../config';
import { propText, type NotionClient } from './client';

export type Posting = { id: string; url: string; company: string; link: string; deadline: string; status: string; roles: string; employment: string };

export async function listPostings(client: NotionClient, settings: Settings, dataSourceId: string, now = new Date()): Promise<Posting[]> {
  const f = settings.notion.fields;
  const pages = await client.queryPages(dataSourceId, 1000);
  const today = now.toISOString().slice(0, 10);
  return pages
    .map((pg) => ({
      id: pg.id,
      url: pg.url,
      company: propText(pg.properties[f.company ?? '']),
      link: propText(pg.properties[f.link ?? '']),
      deadline: propText(pg.properties[f.deadline ?? '']),
      status: propText(pg.properties[f.status ?? '']),
      roles: propText(pg.properties[f.roles ?? '']),
      employment: propText(pg.properties[f.employment ?? '']),
    }))
    .filter((p) => p.company && (!p.deadline || p.deadline.slice(0, 10) >= today)) // 마감 지난 공고는 뺀다
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
}
