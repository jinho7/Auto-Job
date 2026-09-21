// 자기소개서 소재 폴더: 사용자가 연결한 내 컴퓨터의 폴더에서 소재가 될 파일을 찾는다.
// AI 는 소재를 찾는 단계에서만 이 폴더를 읽고(웹 도구 없음), 글을 쓰는 단계에서는 찾은 소재만 받는다.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '../paths';

export const SOURCE_EXTS = ['md', 'markdown', 'txt', 'pdf'];
const TEXT_EXTS = new Set(['md', 'markdown', 'txt']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.obsidian', '.trash', '__pycache__']);
const MAX_FILES = 400;
const MAX_DEPTH = 6;

export type SourceFile = { rel: string; ext: string; size: number; modified: string };
export type SourceFolder = { path: string; note?: string; ok: boolean; error?: string; files: SourceFile[]; truncated?: boolean; warnings?: string[] };

export function scanFolder(dir: string, note?: string): SourceFolder {
  const abs = path.resolve(expandHome(dir.trim()));
  if (!existsSync(abs)) return { path: abs, note, ok: false, error: '폴더가 없습니다', files: [] };
  if (!statSync(abs).isDirectory()) return { path: abs, note, ok: false, error: '폴더가 아닙니다', files: [] };
  const files: SourceFile[] = [];
  const warnings: string[] = [];
  let truncated = false;
  const walk = (d: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      warnings.push(`${d}: 하위 폴더를 읽지 못했습니다. 접근 권한을 확인해 주세요`);
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || files.length >= MAX_FILES) {
        if (files.length >= MAX_FILES) truncated = true;
        continue;
      }
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && depth < MAX_DEPTH) walk(full, depth + 1);
        else if (!SKIP_DIRS.has(e.name)) truncated = true;
      } else if (e.isFile()) {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (!SOURCE_EXTS.includes(ext)) continue;
        const st = statSync(full);
        files.push({ rel: path.relative(abs, full), ext, size: st.size, modified: st.mtime.toISOString().slice(0, 10) });
      }
    }
  };
  walk(abs, 0);
  return { path: abs, note, ok: true, files, ...(truncated ? { truncated } : {}), ...(warnings.length ? { warnings } : {}) };
}

export function scanFolders(folders: { path?: string; note?: string }[]): SourceFolder[] {
  return folders.filter((f) => f.path?.trim()).map((f) => scanFolder(f.path!, f.note || undefined));
}

const kb = (n: number) => (n < 1024 ? `${n}B` : `${Math.round(n / 1024)}KB`);

/** AI 에게 줄 파일 목록 */
export function sourceIndex(folders: SourceFolder[]): string {
  return folders
    .filter((f) => f.ok)
    .map((f) => [`### ${f.path}${f.note ? ` — ${f.note}` : ''}`, ...f.files.map((x) => `- ${x.rel} (${x.ext}, ${kb(x.size)}, ${x.modified})`), f.truncated ? '- … (파일이 많아 일부만 보여 줌)' : ''].filter(Boolean).join('\n'))
    .join('\n\n');
}

/** 파일을 직접 읽을 수 없는 AI 연결 방식용: 글 파일 내용을 정해진 분량까지 붙인다 (PDF 는 빼고 알려 준다) */
export function inlineSources(folders: SourceFolder[], budget = 120_000): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  let used = 0;
  for (const f of folders.filter((x) => x.ok)) {
    for (const file of f.files) {
      const full = path.join(f.path, file.rel);
      if (!TEXT_EXTS.has(file.ext)) {
        skipped.push(`${file.rel} (PDF 는 Claude Code 연결에서만 읽습니다)`);
        continue;
      }
      if (used >= budget) {
        skipped.push(`${file.rel} (분량 초과)`);
        continue;
      }
      const body = readFileSync(full, 'utf8').slice(0, budget - used);
      used += body.length;
      parts.push(`=== ${file.rel} ===\n${body}`);
    }
  }
  return { text: parts.join('\n\n'), skipped };
}
