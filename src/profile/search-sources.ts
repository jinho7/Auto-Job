// Search uses career evidence, not contact details. All backends receive the same
// text; no agent gets arbitrary filesystem access or instructions from documents.
import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { scanFolders } from '../essay/sources';

type Data = Record<string, any>;
export type SearchDocument = { source: string; text: string };
export type SearchCorpus = { documents: SearchDocument[]; warnings: string[]; filesRead: number };
const exec = promisify(execFile);

function compact(value: any): any {
  if (Array.isArray(value)) {
    const items = value.map(compact).filter((v) => v !== undefined);
    return items.length ? items : undefined;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => [k, compact(v)]).filter(([, v]) => v !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return value === null || value === undefined || value === '' ? undefined : value;
}
const fields = (xs: Data[] | undefined, keys: string[]) => (xs ?? []).map((x) => Object.fromEntries(keys.map((k) => [k, x[k]])));

/** Deliberately omit identity, contact information, registration numbers and pay. */
export function searchProfile(profile: Data): Data {
  return compact({
    education: {
      universities: fields(profile.education?.universities, ['degree', 'major', 'double_major', 'minor', 'status', 'graduated', 'thesis']),
      research: fields(profile.education?.research, ['title', 'role', 'summary']),
    },
    career: {
      experiences: fields(profile.career?.experiences, ['type', 'department', 'position', 'start', 'end', 'duties']),
      trainings: fields(profile.career?.trainings, ['name', 'content']),
      ncs: fields(profile.career?.ncs, ['category', 'name', 'content']),
    },
    extras: {
      languages: fields(profile.extras?.languages, ['test', 'score', 'expires']),
      language_skills: profile.extras?.language_skills,
      certificates: fields(profile.extras?.certificates, ['name', 'expires']),
      awards: fields(profile.extras?.awards, ['name', 'detail']),
      activities: fields(profile.extras?.activities, ['type', 'name', 'role', 'detail']),
      computer_skills: profile.extras?.computer_skills,
    },
    target: { job_roles: profile.target?.job_roles, employment_types: profile.target?.employment_types, regions: profile.target?.regions },
    stories: profile.stories?.items,
  }) ?? {};
}

export function hasSearchProfile(profile: Data): boolean {
  return Object.keys(searchProfile(profile)).length > 0 || (profile.stories?.folders ?? []).some((f: Data) => f.path?.trim());
}

/** PDF extraction is local and optional. Scans without a text layer are reported. */
export async function pdfText(file: string): Promise<string> {
  try {
    const { stdout } = await exec('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    if (!stdout.trim()) throw new Error('텍스트가 없는 PDF입니다. OCR한 문서나 md/txt를 연결해 주세요');
    return stdout;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('PDF를 읽으려면 Poppler의 pdftotext가 필요합니다. 설치하거나 md/txt로 연결해 주세요');
    throw new Error((e as Error).message.startsWith('텍스트가 없는') ? (e as Error).message : 'PDF 텍스트를 읽지 못했습니다 (암호화·손상·분량·시간 제한 확인)');
  }
}

export async function readSearchCorpus(profile: Data, readPdf = pdfText): Promise<SearchCorpus> {
  const documents: SearchDocument[] = [];
  const warnings: string[] = [];
  const structured = searchProfile(profile);
  if (Object.keys(structured).length) documents.push({ source: '내 정보', text: JSON.stringify(structured, null, 2) });
  let folders;
  try { folders = scanFolders(profile.stories?.folders ?? []); }
  catch { throw new Error('연결한 자료 폴더를 읽지 못했습니다. 폴더 위치와 접근 권한을 확인해 주세요.'); }
  const seen = new Set<string>();
  let filesRead = 0;
  for (const folder of folders) {
    if (!folder.ok) { warnings.push(`${folder.path}: ${folder.error}`); continue; }
    warnings.push(...(folder.warnings ?? []));
    if (folder.note?.trim()) documents.push({ source: `${folder.path} (폴더 설명)`, text: folder.note });
    if (!folder.files.length) warnings.push(`${folder.path}: 읽을 md/txt/pdf 파일이 없습니다`);
    if (folder.truncated) warnings.push(`${folder.path}: 파일 수 또는 폴더 깊이 제한으로 일부 자료를 읽지 못했습니다`);
    for (const file of folder.files) {
      const source = path.join(folder.path, file.rel);
      try {
        const actual = realpathSync(source);
        const relative = path.relative(realpathSync(folder.path), actual);
        if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('연결 폴더 밖 파일은 읽지 않습니다');
        if (seen.has(actual)) continue;
        seen.add(actual);
        if (statSync(actual).size > 8 * 1024 * 1024) throw new Error('8MB를 넘는 자료입니다. 작은 파일로 나눠 주세요');
        const text = file.ext === 'pdf' ? await readPdf(actual) : readFileSync(actual, 'utf8');
        if (!text.trim()) throw new Error('내용이 비어 있습니다');
        documents.push({ source, text });
        filesRead++;
      } catch (e) { warnings.push(`${source}: ${(e as Error).message}`); }
    }
  }
  return { documents, warnings, filesRead };
}

/** No silent front-of-file truncation: every part is sent to the AI. */
export function searchBatches(documents: SearchDocument[], size = 30_000): SearchDocument[][] {
  const batches: SearchDocument[][] = [];
  let batch: SearchDocument[] = [], used = 0;
  for (const doc of documents) {
    for (let start = 0; start < doc.text.length; start += size) {
      const part = { source: doc.source, text: doc.text.slice(start, start + size) };
      if (used + part.text.length > size && batch.length) { batches.push(batch); batch = []; used = 0; }
      batch.push(part); used += part.text.length;
    }
  }
  if (batch.length) batches.push(batch);
  return batches;
}
