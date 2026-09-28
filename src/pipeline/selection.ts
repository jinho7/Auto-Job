import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { collectorById } from '../collectors';
import type { CollectorContext, RawPosting } from '../collectors/types';
import type { CollectReport } from './collect';
import { paths } from '../paths';

export type PreviewSelection = { preview: string; ids: string[]; groupAffiliates?: boolean };

/** Resolve only server-saved candidate IDs; the client cannot supply postings or arbitrary file paths. */
export function selectedFromPreview(selection: PreviewSelection, runs = paths.runs): RawPosting[] {
  if (!/^[\w-]+_collect-preview$/.test(selection.preview)) throw new Error('미리보기 실행을 다시 선택해 주세요.');
  if (!Array.isArray(selection.ids) || !selection.ids.length || selection.ids.length > 50 || new Set(selection.ids).size !== selection.ids.length) throw new Error('한 번에 공고 1~50개를 선택해 주세요.');
  const file = realpathSync(path.join(runs, selection.preview, 'report.json'));
  if (!file.startsWith(realpathSync(runs) + path.sep)) throw new Error('미리보기 저장 위치가 올바르지 않습니다.');
  const report: CollectReport = JSON.parse(readFileSync(file, 'utf8'));
  if (report.phase !== 'preview' || !report.dryRun) throw new Error('목록 미리보기 결과에서 공고를 선택해 주세요.');
  return selection.ids.map(id => {
    const item = report.items.find(item => item.id === id && item.outcome === 'candidate');
    if (!item?.candidate) throw new Error('선택한 공고가 미리보기 결과에 없습니다. 다시 확인해 주세요.');
    return structuredClone(item.candidate);
  });
}

export function withSelectedDetails(postings: RawPosting[], ctx: CollectorContext): RawPosting[] {
  return postings.map(posting => {
    const collector = collectorById(posting.source);
    if (!collector?.detail) throw new Error(`${posting.source}: 선택 공고 상세 확인을 지원하지 않습니다.`);
    return { ...posting, detail: () => collector.detail!(ctx, posting) };
  });
}
