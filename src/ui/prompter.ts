// 대화형 입력 추상화. 실제로는 @inquirer/prompts 를 쓰고, 테스트에서는 정해진 답을 흘려보낸다.
import { checkbox, confirm, input, password, select } from '@inquirer/prompts';

export type Choice<T> = { name: string; value: T; description?: string; checked?: boolean };

export interface Prompter {
  input(o: { message: string; default?: string; validate?: (v: string) => true | string }): Promise<string>;
  /** 입력 내용이 화면에 보이지 않는 입력 (토큰, API 키) */
  password(o: { message: string }): Promise<string>;
  select<T>(o: { message: string; choices: Choice<T>[]; default?: T }): Promise<T>;
  checkbox<T>(o: { message: string; choices: Choice<T>[] }): Promise<T[]>;
  confirm(o: { message: string; default?: boolean }): Promise<boolean>;
}

export const inquirerPrompter: Prompter = {
  input: (o) => input(o),
  password: (o) => password({ ...o, mask: '•' }),
  select: <T>(o: { message: string; choices: Choice<T>[]; default?: T }) => select<T>({ ...o, pageSize: 15, loop: false }),
  checkbox: <T>(o: { message: string; choices: Choice<T>[] }) => checkbox<T>({ ...o, pageSize: 15, loop: false }),
  confirm: (o) => confirm(o),
};

/** 여러 줄 입력: 빈 줄을 입력하면 끝 */
export async function multiline(p: Prompter, message: string): Promise<string> {
  const lines: string[] = [];
  for (;;) {
    const line = await p.input({ message: lines.length ? '  (계속, 빈 줄이면 끝)' : `${message} (여러 줄, 빈 줄이면 끝)` });
    if (line === '') break;
    lines.push(line);
  }
  return lines.join('\n');
}

/** Ctrl+C 로 대화형 입력을 끝냈는지 */
export function isPromptExit(e: unknown): boolean {
  return e instanceof Error && (e.name === 'ExitPromptError' || e.name === 'AbortPromptError');
}
