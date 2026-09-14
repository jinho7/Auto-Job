import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { paths } from '../src/paths';
import { loadSchema } from '../src/profile/schema';
import { ProfileStore } from '../src/profile/store';
import type { Choice, Prompter } from '../src/ui/prompter';

export const tempDir = () => mkdtempSync(path.join(tmpdir(), 'autojob-test-'));

export function freshProfile(): ProfileStore {
  const store = new ProfileStore(path.join(tempDir(), 'me'), loadSchema(paths.profileSchema));
  store.initFiles();
  return store;
}

export function freshSettingsFile(): string {
  const file = path.join(tempDir(), 'settings.yaml');
  cpSync(paths.settingsExample, file);
  return file;
}

type Answer = unknown | ((o: { message: string; choices?: Choice<unknown>[] }) => unknown);

/** 이름에 text 가 들어간 선택지를 고른다 */
export const pick = (text: string) => (o: { message: string; choices?: Choice<unknown>[] }) => {
  const c = o.choices?.find((x) => x.name.includes(text));
  if (!c) throw new Error(`선택지 "${text}" 없음 (질문: ${o.message}; 선택지: ${o.choices?.map((x) => x.name).join(' | ')})`);
  return c.value;
};

/** 정해진 답을 차례로 돌려주는 가짜 입력기. asked 에 질문이 쌓인다. */
export function scripted(answers: Answer[]): Prompter & { asked: string[]; remaining: () => number } {
  const asked: string[] = [];
  const next = (o: { message: string; choices?: Choice<unknown>[]; validate?: (v: string) => true | string }) => {
    asked.push(o.message);
    if (!answers.length) throw new Error(`준비된 답이 없습니다 (질문: ${o.message})`);
    const a = answers.shift();
    const v = typeof a === 'function' ? (a as (x: typeof o) => unknown)(o) : a;
    if (o.validate && typeof v === 'string') {
      const ok = o.validate(v);
      if (ok !== true) throw new Error(`검증 실패 "${v}": ${ok}`);
    }
    return Promise.resolve(v);
  };
  return {
    asked,
    remaining: () => answers.length,
    input: (o) => next(o).then((v) => (v === '' && o.default !== undefined ? o.default : v)) as Promise<string>,
    password: (o) => next(o) as Promise<string>,
    select: (o) => next(o as never) as never,
    checkbox: (o) => next(o as never) as never,
    confirm: (o) => next(o) as Promise<boolean>,
  };
}
