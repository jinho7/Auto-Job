// 실제 환경(설정, 브라우저, Notion, 기록 파일)을 묶어 수집을 한 번 실행한다. CLI 와 설정 화면이 같이 쓴다.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { BrowserSession } from '../browser/session';
import { loadSettings } from '../config';
import { PoliteHttp } from '../http';
import { findDuplicate } from '../jobs/dedup';
import { SeenStore } from '../jobs/seen';
import { optionsOf } from '../notion/mapping';
import { jobWriter } from '../notion/setup';
import { paths, runDir } from '../paths';
import { getSecret } from '../secrets';
import { loadSchema } from '../profile/schema';
import { ProfileStore } from '../profile/store';
import { SettingsStore } from '../settings/store';
import { formatReport, runCollect, type CollectReport, type NotionSink } from './collect';

export type CollectRunOptions = { dryRun: boolean; sources?: string[]; limit?: number; log?: (m: string) => void };

export async function collectNow(opts: CollectRunOptions): Promise<{ report: CollectReport; dir: string }> {
  const log = opts.log ?? console.log;
  const settings = loadSettings();
  const profile = new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema)).toJSON();

  let session: BrowserSession | null = null;
  const pages: Record<string, Page> = {};
  const tab = (name: string) => async () => {
    session ??= await BrowserSession.open(settings);
    pages[name] ??= name === 'collect' ? session.page : await session.context.newPage();
    return pages[name];
  };

  let notion: NotionSink | null = null;
  const n = settings.notion;
  if (getSecret('NOTION_TOKEN') && (n.data_source_id || n.database_id)) {
    const { writer, ds } = await jobWriter(new SettingsStore(paths.settings));
    notion = {
      tags: optionsOf(ds.properties[n.fields.roles ?? '']),
      add: (p, o) => writer.add(p, o),
      check: async (p) => findDuplicate(p, await writer.loadExisting()),
    };
    log(`Notion: ${ds.title} (직무 태그 ${notion.tags.length}개)`);
  } else {
    log('Notion 이 연결되지 않아 미리보기만 합니다 (중복 확인도 로컬 기록만).');
  }

  const dir = runDir(opts.dryRun || !notion ? 'collect-preview' : 'collect');
  mkdirSync(dir, { recursive: true });
  try {
    const report = await runCollect({
      settings,
      profile,
      http: new PoliteHttp(settings.collect.request_delay_ms),
      browserPage: tab('collect'),
      linkPage: tab('link'),
      seen: new SeenStore(path.join(paths.data, 'seen.json')),
      notion,
      dryRun: opts.dryRun || !notion,
      sources: opts.sources,
      limit: opts.limit,
      cwd: dir,
      log,
    });
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1), { mode: 0o600 });
    writeFileSync(path.join(dir, 'report.txt'), formatReport(report, { verbose: true }), { mode: 0o600 });
    return { report, dir };
  } finally {
    const s = session as BrowserSession | null;
    if (s) {
      for (const p of Object.values(pages)) await p.close().catch(() => {});
      await s.detach();
    }
  }
}
