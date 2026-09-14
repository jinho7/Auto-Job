// `autojob browser test`: 가짜 지원서 페이지로 드라이버와 제출 차단 가드를 검증한다.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Settings } from '../config';
import { notify } from '../notify';
import { paths, runDir } from '../paths';
import { GuardBlockedError } from './guard';
import { BrowserSession } from './session';

export type Check = { name: string; ok: boolean; detail?: string };
export type SelfTestResult = { driver: string; passed: boolean; checks: Check[]; events: string[] };

export function formatSelfTest(r: SelfTestResult): string {
  const lines = [`\n브라우저 테스트 (${r.driver})`, ...r.checks.map((c) => `  ${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)];
  if (r.events.length) lines.push('\n  이벤트:', ...r.events.map((e) => `    · ${e}`));
  lines.push(`\n${r.passed ? '통과' : '실패'}: ${r.checks.filter((c) => c.ok).length}/${r.checks.length}`);
  return lines.join('\n');
}

export async function browserSelfTest(settings: Settings, opts: { keepOpen?: boolean } = {}): Promise<SelfTestResult> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  if (settings.browser.driver === 'handoff') {
    return { driver: 'handoff', passed: false, checks: [{ name: 'handoff 드라이버는 브라우저를 직접 조종하지 않아 테스트할 수 없습니다', ok: false }], events: [] };
  }
  const session = await BrowserSession.open(settings);
  const { page } = session;
  const log = async () => (await page.textContent('#log')) ?? '';
  const count = (text: string, word: string) => text.split('\n').filter((l) => l === word).length;

  try {
    await session.goto(pathToFileURL(path.join(paths.fixtures, 'fake-application.html')).href);
    await session.bringToFront();
    check('페이지 이동', (await page.title()).includes('가짜 지원서'));

    await session.click('#start');
    check('지원 시작 버튼 허용 (armed 전)', count(await log(), '지원 시작') === 1);

    await session.arm();

    check('빈 칸 입력', (await session.fill('#name', '홍길동')) === 'filled');
    const kept = (await session.fill('#email', 'new@x.com')) === 'skipped-prefilled' && (await page.inputValue('#email')) === 'already@filled.com';
    check('이미 입력된 값 보존', kept);
    await session.fill('#admit', '2019.03');
    check('날짜 텍스트 입력', (await page.inputValue('#admit')) === '2019.03');

    const [popup] = await Promise.all([session.context.waitForEvent('page'), session.click('#addr-search')]);
    await popup.locator('#pick').click();
    await page.waitForFunction(() => (document.querySelector('#addr') as HTMLInputElement).value !== '');
    check('주소 팝업 처리', (await page.inputValue('#addr')).includes('세종대로'));

    const essay = '[테스트 소제목]\n자기소개서 입력 테스트입니다.';
    await session.fill('#q1', essay);
    check('자소서 입력', (await page.inputValue('#q1')) === essay);

    await session.click('#save');
    check('임시저장 허용', count(await log(), '임시저장됨') === 1);

    // 2차 가드: session.click 은 금지 버튼을 거부해야 한다
    const rejected = async (sel: string) => session.click(sel).then(() => false, (e) => e instanceof GuardBlockedError);
    check('2차 가드: 최종 제출 거부', await rejected('#submit'));
    check('2차 가드: 지원하기 거부 (armed 후)', await rejected('#start'));

    // 1차 가드: 가드를 우회해 직접 눌러도 페이지 안에서 막혀야 한다
    await page.locator('#submit').click();
    await page.locator('#start').click();
    await page.locator('#name').press('Enter'); // 엔터로 암묵적 제출
    await page.waitForTimeout(300);
    const after = await log();
    check('1차 가드: 최종 제출 클릭 차단', !after.includes('SUBMITTED'));
    check('1차 가드: 지원하기 클릭 차단 (armed 후)', count(after, '지원 시작') === 1);

    // 대화상자: "최종 제출하시겠습니까?" 확인창은 거절
    await page.locator('#leave').click();
    await page.waitForTimeout(300);
    check('제출 확인 대화상자 거절', !(await log()).includes('SUBMITTED-VIA-CONFIRM'));

    const dir = runDir('browser-test');
    mkdirSync(dir, { recursive: true });
    const shot = path.join(dir, 'screenshot.png');
    await session.screenshot(shot);
    check('스크린샷 저장', true, path.relative(process.cwd(), shot));
  } catch (e) {
    check('예외 없이 완료', false, (e as Error).message);
  } finally {
    await session.detach({ closeTab: !opts.keepOpen });
  }

  const passed = checks.every((c) => c.ok);
  notify('Auto-Job 브라우저 테스트', passed ? `통과 (${checks.length}개 항목)` : '실패한 항목이 있습니다');
  return { driver: settings.browser.driver, passed, checks, events: session.events };
}
