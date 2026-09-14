import { existsSync } from 'node:fs';
import { Command } from 'commander';
import YAML from 'yaml';
import { BrowserSession } from './browser/session';
import { browserSelfTest, formatSelfTest } from './browser/selftest';
import { loadSettings } from './config';
import { COLLECTORS } from './collectors';
import { ensureInitialized } from './init';
import { notify } from './notify';
import { formatReport } from './pipeline/collect';
import { collectNow } from './pipeline/run';
import { parseDeadline, type JobPosting } from './jobs/model';
import { bootstrapDatabase } from './notion/bootstrap';
import { checkCurrent, jobWriter, notionClient } from './notion/setup';
import { parseNotionId } from './settings/store';
import { openUrl } from './open';
import { startServer } from './server/server';
import { paths } from './paths';
import { checkProfile } from './profile/check';
import { ProfileEditor } from './profile/editor';
import { loadSchema } from './profile/schema';
import { renderProfile, renderSchemaPaths } from './profile/show';
import { ProfileStore } from './profile/store';
import { SettingsEditor } from './settings/editor';
import { SettingsStore } from './settings/store';
import { inquirerPrompter, isPromptExit } from './ui/prompter';

const program = new Command()
  .name('autojob')
  .description('채용 공고 수집 → Notion 정리 → 지원서 작성(임시저장)까지 자동화');

/** 오류는 한 줄 메시지로, Ctrl+C 는 조용히 종료 */
const run =
  <A extends unknown[]>(fn: (...args: A) => unknown) =>
  async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      if (isPromptExit(e)) return console.log('\n중단했습니다. 그때까지 입력한 내용은 저장되어 있습니다.');
      console.error(`❌ ${(e as Error).message}`);
      process.exitCode = 1;
    }
  };

const profileStore = () => new ProfileStore(paths.profileMe, loadSchema(paths.profileSchema));
const settingsStore = () => {
  if (!existsSync(paths.settings)) throw new Error('settings.yaml 이 없습니다. 먼저 `autojob init`을 실행하세요.');
  return new SettingsStore(paths.settings);
};

// ─── init ───────────────────────────────────────────────
program
  .command('init')
  .description('처음 설치: 설정 파일과 내 정보 파일을 만든다 (이미 있으면 건드리지 않음)')
  .action(
    run(() => {
      const r = ensureInitialized();
      console.log(r.settingsCreated ? '✅ settings.yaml 생성' : '· settings.yaml 이미 있음 (유지)');
      console.log(r.profileCreated.length ? `✅ profile/me/ 생성: ${r.profileCreated.join(', ')}` : '· profile/me/ 이미 있음 (유지)');
      console.log(
        '\n다음 단계:\n' +
          '  autojob ui                화면에서 설정과 내 정보를 한 번에 입력 (추천)\n' +
          '  또는 터미널에서:\n' +
          '  autojob settings          검색 키워드, 수집 사이트, 기업 구분, Notion 연결\n' +
          '  autojob profile edit      내 정보 입력\n' +
          '  autojob browser test      브라우저 연결과 제출 차단 확인',
      );
    }),
  );

// ─── ui ─────────────────────────────────────────────────
program
  .command('ui')
  .description('설정 화면을 브라우저로 연다 (내 컴퓨터에서만 접속 가능)')
  .option('--port <port>', '포트', '4777')
  .option('--no-open', '브라우저를 자동으로 열지 않는다')
  .action(
    run(async (opts: { port: string; open: boolean }) => {
      ensureInitialized();
      const { url } = await startServer(Number(opts.port));
      console.log(`✅ Auto-Job 설정 화면: ${url}\n   (이 주소는 실행할 때마다 바뀝니다. 끄려면 Ctrl+C)`);
      if (opts.open) openUrl(url);
      await new Promise(() => {}); // Ctrl+C 까지 유지
    }),
  );

// ─── profile ────────────────────────────────────────────
const profile = program.command('profile').description('내 정보 (항목 정의: profile/schema.yaml)');

profile
  .command('edit')
  .description('대화형으로 내 정보를 입력하고 고친다')
  .argument('[section]', 'basic | education | career | extras | target | stories')
  .action(run((section?: string) => new ProfileEditor(profileStore(), inquirerPrompter).run(section)));

profile
  .command('show')
  .description('내 정보를 보여준다')
  .argument('[section]', '섹션 이름')
  .option('--filled', '입력된 항목만')
  .action(
    run((section: string | undefined, opts: { filled?: boolean }) => {
      const store = profileStore();
      console.log(renderProfile(store.toJSON(), store.schema, { section, filledOnly: opts.filled }));
    }),
  );

profile
  .command('check')
  .description('필수 항목, 형식 오류, 항목 정의에 없는 키를 검사한다')
  .action(
    run(() => {
      const store = profileStore();
      const r = checkProfile(store.toJSON(), store.schema, store.filesDir);
      console.log(`입력된 항목: ${r.filled}/${r.total}`);
      const list = (title: string, xs: { where: string; path: string; message: string }[]) =>
        xs.length && console.log(`\n${title}\n` + xs.map((x) => `  - ${x.where}: ${x.message}   (${x.path})`).join('\n'));
      list('❗ 필수 항목', r.missing);
      list('❌ 형식 오류', r.errors);
      if (r.unknown.length) console.log('\n⚠️  항목 정의에 없는 키 (오타 확인):\n' + r.unknown.map((u) => `  - ${u}`).join('\n'));
      if (!r.missing.length && !r.errors.length) console.log('\n✅ 문제 없음');
      if (r.missing.length || r.errors.length) process.exitCode = 1;
    }),
  );

profile
  .command('set')
  .description('값 하나를 바로 넣는다 (예: profile set basic.phone 010-1234-5678)')
  .argument('<path>', '경로 (autojob profile schema 로 확인)')
  .argument('<value...>', '값. tags 는 쉼표로 구분, "" 는 비우기')
  .action(
    run((p: string, value: string[]) => {
      const store = profileStore();
      store.set(p, value.join(' '));
      console.log(`✅ ${store.field(p).label} = ${JSON.stringify(store.get(p))}`);
    }),
  );

profile
  .command('add')
  .description('목록에 항목을 추가한다 (예: profile add extras.certificates name=정보처리기사 date=2025.06.13)')
  .argument('<list>', '목록 경로')
  .argument('[pairs...]', 'key=값')
  .action(
    run((list: string, pairs: string[]) => {
      const values = Object.fromEntries(
        pairs.map((kv) => {
          const i = kv.indexOf('=');
          if (i < 1) throw new Error(`key=값 형식이 아닙니다: ${kv}`);
          return [kv.slice(0, i), kv.slice(i + 1)];
        }),
      );
      const store = profileStore();
      const idx = store.addItem(list, values);
      console.log(`✅ ${store.field(list).label} #${idx + 1} 추가  (경로: ${list}.${idx})`);
    }),
  );

profile
  .command('remove')
  .description('목록 항목을 삭제한다 (예: profile remove extras.certificates.0)')
  .argument('<path>', '항목 경로')
  .action(
    run((p: string) => {
      profileStore().removeItem(p);
      console.log(`✅ ${p} 삭제`);
    }),
  );

profile
  .command('schema')
  .description('입력할 수 있는 항목과 경로를 보여준다')
  .action(run(() => console.log(renderSchemaPaths(loadSchema(paths.profileSchema)))));

// ─── settings ───────────────────────────────────────────
const settings = program
  .command('settings')
  .description('설정 (인자 없이 실행하면 대화형 편집기)')
  .action(run(() => new SettingsEditor(settingsStore(), inquirerPrompter, console.log, () => (profileStore().get('target.job_roles') as string[] | undefined) ?? []).run()));

settings
  .command('show')
  .description('현재 설정을 보여준다')
  .argument('[path]', '일부만 (예: collect)')
  .action(run((p?: string) => {
    const store = settingsStore();
    console.log(YAML.stringify(p ? store.get(p) : store.settings).trimEnd());
  }));

settings
  .command('set')
  .description('값을 바꾼다 (예: settings set browser.driver chrome)')
  .argument('<path>')
  .argument('<value...>')
  .action(run((p: string, value: string[]) => {
    const store = settingsStore();
    store.setFromText(p, value.join(' '));
    console.log(`✅ ${p} = ${JSON.stringify(store.get(p))}`);
  }));

settings
  .command('add')
  .description('목록에 추가한다 (예: settings add collect.keywords 백엔드 "Spring Boot")')
  .argument('<path>')
  .argument('<values...>')
  .action(run((p: string, values: string[]) => {
    const added = settingsStore().addToList(p, values);
    console.log(added.length ? `✅ 추가: ${added.join(', ')}` : '새로 추가된 항목이 없습니다');
  }));

settings
  .command('remove')
  .description('목록에서 뺀다 (예: settings remove collect.keywords 백엔드)')
  .argument('<path>')
  .argument('<values...>')
  .action(run((p: string, values: string[]) => {
    const removed = settingsStore().removeFromList(p, values);
    console.log(removed.length ? `✅ 삭제: ${removed.join(', ')}` : '목록에 없는 값입니다');
  }));

// ─── notion ─────────────────────────────────────────────
const notion = program.command('notion').description('Notion 연동 (토큰과 DB 는 autojob ui / autojob settings 에서 설정)');

notion
  .command('test')
  .description('토큰으로 연결되는지 확인한다')
  .action(run(async () => {
    const me = await notionClient().me();
    console.log(`✅ 연결됨: ${me.name}${me.workspace ? ` (워크스페이스: ${me.workspace})` : ''}`);
  }));

notion
  .command('check')
  .description('설정의 속성 이름과 옵션이 DB 와 맞는지 검사한다')
  .action(run(async () => {
    const { ds, report } = await checkCurrent(settingsStore());
    console.log(`DB: ${ds.title}`);
    for (const f of report.fields) console.log(`  ${f.ok ? '✅' : '❌'} ${f.label} → ${f.configured || '(없음)'}${f.problem ? `  — ${f.problem}` : ''}${f.suggestion ? `  (후보: ${f.suggestion})` : ''}`);
    for (const o of report.optionProblems) console.log(`  ⚠️  ${o}`);
    if (!report.ok) process.exitCode = 1;
  }));

notion
  .command('list')
  .description('DB 에 있는 공고를 보여준다')
  .option('--limit <n>', '최대 개수', '30')
  .action(run(async (opts: { limit: string }) => {
    const { writer, ds } = await jobWriter(settingsStore());
    const jobs = await writer.loadExisting();
    const sorted = [...jobs].sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    console.log(`${ds.title}: ${jobs.length}건 (마감 가까운 순, 상시는 뒤)`);
    for (const j of sorted.slice(0, Number(opts.limit))) console.log(`  ${(j.deadline.slice(0, 16) || '상시').padEnd(16)}  ${j.company}${j.link ? `  ${j.link}` : ''}`);
  }));

notion
  .command('add')
  .description('공고 1건을 DB 에 추가한다 (중복이면 넣지 않음)')
  .requiredOption('--company <name>', '회사명')
  .requiredOption('--link <url>', '실제 지원 페이지 (필수)')
  .option('--deadline <text>', '마감 (예: 2026-09-30 18:00, 상시)', '상시')
  .option('--roles <list>', '직무 태그, 쉼표로 (DB 에 있는 이름만 들어감)', '')
  .option('--employment <list>', '채용 분류, 쉼표로: 정규직, 채용연계형인턴, 체험형인턴, 계약직', '')
  .option('--type <companyType>', '기업 구분 (대기업, 유명IT, ...) — 작성중 표시 판단에 씀')
  .option('--note <text>', '참고 키워드')
  .option('--dry-run', 'Notion 에 쓰지 않고 넣을 값만 보여준다')
  .action(run(async (o: { company: string; link: string; deadline: string; roles: string; employment: string; type?: string; note?: string; dryRun?: boolean }) => {
    const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
    const posting: JobPosting = {
      company: o.company,
      link: o.link,
      deadline: parseDeadline(o.deadline),
      roles: list(o.roles),
      employment: list(o.employment),
      companyType: o.type,
      note: o.note,
    };
    const { writer } = await jobWriter(settingsStore());
    const r = await writer.add(posting, { dryRun: o.dryRun });
    if (r.status === 'duplicate') {
      console.log(`⏭️  중복이라 넣지 않았습니다: ${r.duplicate.reason} — ${r.duplicate.existing.company} ${r.duplicate.existing.url ?? ''}`);
      return;
    }
    for (const d of r.dropped) console.log(`  ⚠️  ${d}`);
    if (r.status === 'dry-run') {
      console.log(`미리보기 (본문: ${r.usedTemplate ? 'DB 기본 템플릿' : '설정의 제목들'})\n${JSON.stringify(r.properties, null, 2)}`);
      return;
    }
    console.log(`✅ 추가했습니다${r.usedTemplate ? ' (DB 기본 템플릿 적용)' : ''}: ${r.url}`);
  }));

notion
  .command('bootstrap')
  .description('새 사용자용: 공고 정리 DB 를 새로 만들고 설정에 연결한다')
  .option('--parent <page>', 'DB 를 만들 Notion 페이지 URL 또는 ID (생략하면 목록에서 고름)')
  .option('--title <title>', 'DB 제목', '서류 제출 자료')
  .action(run(async (o: { parent?: string; title: string }) => {
    const client = notionClient();
    let parent = o.parent ? parseNotionId(o.parent) : null;
    if (o.parent && !parent) throw new Error('페이지 URL/ID 에서 Notion ID 를 찾지 못했습니다');
    if (!parent) {
      const pages = await client.searchPages();
      if (!pages.length) throw new Error('이 연결이 볼 수 있는 페이지가 없습니다. DB 를 만들 페이지의 ••• → 연결에서 통합을 추가해 주세요.');
      parent = await inquirerPrompter.select({ message: 'DB 를 만들 페이지', choices: pages.map((p) => ({ name: p.title, value: p.id })) });
    }
    const roles = (profileStore().get('target.job_roles') as string[] | undefined) ?? [];
    const created = await bootstrapDatabase(client, settingsStore(), parent, o.title, roles);
    console.log(`✅ DB 를 만들고 설정에 연결했습니다: ${created.url}`);
    console.log(`   직무 태그: ${roles.length ? roles.join(', ') : '(없음 — 내 정보의 희망 직무를 채우거나 Notion 에서 직접 추가하세요)'}`);
  }));

// ─── browser ────────────────────────────────────────────
const browser = program.command('browser').description('브라우저 드라이버');
browser
  .command('open')
  .description('자동화 프로필로 브라우저를 띄운다 (채용 사이트에 미리 로그인해 둘 때)')
  .argument('[url]', '열 주소')
  .action(
    run(async (url?: string) => {
      const session = await BrowserSession.open(loadSettings());
      if (url) await session.goto(url);
      await session.bringToFront();
      console.log('✅ 브라우저가 열렸습니다. 로그인해 두면 이 프로필에 유지됩니다.');
      await session.detach();
    }),
  );
browser
  .command('test')
  .description('가짜 지원서 페이지로 입력과 제출 차단 가드를 검증한다')
  .option('--driver <driver>', 'aside | chrome (설정보다 우선)')
  .option('--keep-open', '테스트 탭을 닫지 않는다')
  .action(
    run(async (opts: { driver?: 'aside' | 'chrome'; keepOpen?: boolean }) => {
      const s = loadSettings();
      if (opts.driver) s.browser.driver = opts.driver;
      const r = await browserSelfTest(s, { keepOpen: opts.keepOpen });
      console.log(formatSelfTest(r));
      if (!r.passed) process.exitCode = 1;
    }),
  );

// ─── 이후 단계 ──────────────────────────────────────────
const notYet = (milestone: string) => () => {
  console.log(`아직 구현되지 않았습니다 (${milestone}). PLAN.md 로드맵 참고.`);
  process.exitCode = 2;
};
program
  .command('collect')
  .description('공고 수집 → 필터 → 중복 제외 → Notion 등록')
  .option('--dry-run', 'Notion 에 쓰지 않고 등록될 공고만 보여준다')
  .option('--source <ids>', '이 수집기만 (쉼표로 구분, 예: saramin,jasoseol)')
  .option('--limit <n>', '등록(미리보기) 최대 건수 — 시험 실행용')
  .option('--verbose', '중복, 기업 구분 제외 공고도 보여준다')
  .option('--list-sources', '수집기 목록과 상태만 보여준다')
  .action(
    run(async (o: { dryRun?: boolean; source?: string; limit?: string; verbose?: boolean; listSources?: boolean }) => {
      if (o.listSources) {
        const s = loadSettings();
        const mark = { ok: '✅', planned: '🕓', blocked: '⛔' } as const;
        for (const c of COLLECTORS) console.log(`${mark[c.status]} ${c.id.padEnd(9)} ${c.label} — ${c.note}${c.status === 'ok' ? (s.collect.sources[c.id] ? '  [켜짐]' : '  [꺼짐]') : ''}`);
        return;
      }
      const { report, dir } = await collectNow({
        dryRun: !!o.dryRun,
        sources: o.source?.split(',').map((x) => x.trim()).filter(Boolean),
        limit: o.limit ? Number(o.limit) : undefined,
      });
      console.log(`\n${formatReport(report, { verbose: o.verbose })}`);
      console.log(`\n리포트: ${dir}`);
      notify('Auto-Job 공고 수집', `${report.dryRun ? '미리보기' : '등록'} ${report.counts.registered ?? report.counts.would_register ?? 0}건`);
    }),
  );
program.command('apply').description('지원서 작성 (임시저장까지)').argument('<target>', 'Notion 페이지 또는 공고 URL').action(notYet('M3~M5'));

await program.parseAsync();
