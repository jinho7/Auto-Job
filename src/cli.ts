import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import { applyNow, buildPageContent, formatApplyReport, type ApplyReport, type ApplyStep } from './apply/run';
import { fillPageSections, setSubmitStatus } from './notion/page-fill';
import { parseQuestionsText } from './essay/checks';
import { formatEssays, writeEssays } from './essay/pipeline';
import YAML from 'yaml';
import { BrowserSession } from './browser/session';
import { browserSelfTest, formatSelfTest } from './browser/selftest';
import { loadSettings } from './config';
import { COLLECTORS } from './collectors';
import { formatDoctor, runDoctor } from './doctor';
import { ensureInitialized } from './init';
import { testAi } from './llm';
import { notify } from './notify';
import { formatReport } from './pipeline/collect';
import { collectNow } from './pipeline/run';
import { parseDeadline, type JobPosting } from './jobs/model';
import { bootstrapDatabase } from './notion/bootstrap';
import { checkCurrent, jobWriter, notionClient } from './notion/setup';
import { parseNotionId } from './settings/store';
import { openUrl } from './open';
import { startOrReuseUi } from './server/ui-instance';
import { closeApplyJobs } from './server/api';
import type { Server } from 'node:http';
import { paths, runDir } from './paths';
import { checkProfile } from './profile/check';
import { applyImport, importProfileText } from './profile/import';
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

async function waitForUiShutdown(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void closeApplyJobs().then(() => new Promise<void>(r => server.close(() => r()))).then(resolve, reject);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

// ─── init ───────────────────────────────────────────────
program
  .command('init')
  .description('처음 설치: 설정 파일과 내 정보 파일을 만들고, 설정을 차례대로 안내한다 (이미 있으면 건드리지 않음)')
  .option('--no-wizard', '파일만 만들고 안내는 하지 않는다')
  .action(
    run(async (o: { wizard: boolean }) => {
      const r = ensureInitialized();
      console.log(r.settingsCreated ? `✅ 설정 파일 생성: ${paths.settings}` : '· 설정 파일 이미 있음 (유지)');
      if (r.settingsCreated) console.log(r.browser ? `✅ 브라우저: ${r.browser}` : '⚠️  Aside 나 Chrome 을 찾지 못했습니다. 설치한 뒤 설정 → 브라우저에서 위치를 적어 주세요.');
      console.log(r.profileCreated.length ? `✅ 내 정보 파일 생성: ${r.profileCreated.join(', ')}` : '· 내 정보 파일 이미 있음 (유지)');
      if (!o.wizard || !process.stdin.isTTY) {
        console.log('\n다음 단계: `autojob ui` (설정 화면) 또는 `autojob doctor` (준비 상태 점검)');
        return;
      }
      const how = await inquirerPrompter.select({
        message: '설정을 어떻게 할까요?',
        choices: [
          { name: '설정 화면에서 (추천) — 브라우저로 열립니다', value: 'ui' as const },
          { name: '터미널에서 차례대로', value: 'terminal' as const },
          { name: '나중에', value: 'later' as const },
        ],
      });
      if (how === 'ui') {
        const ui = await startOrReuseUi(4777);
        console.log(`✅ 설정 화면: ${ui.url}\n   ${ui.reused ? '실행 중인 Auto-Job 화면을 다시 엽니다.' : '"시작하기" 목록을 따라 하면 됩니다. 끝나면 Ctrl+C'}`);
        openUrl(ui.url);
        if (!ui.reused) await waitForUiShutdown(ui.server);
        return;
      }
      if (how === 'terminal') {
        await new SettingsEditor(settingsStore(), inquirerPrompter, console.log, () => (profileStore().get('target.job_roles') as string[] | undefined) ?? []).wizard();
        console.log('\n── 내 정보 ──\n지원서에 들어갈 정보입니다. 없는 값은 비워 두세요 (AI 가 추정해서 채우지 않습니다).');
        if (await inquirerPrompter.confirm({ message: '지금 입력할까요?', default: true })) await new ProfileEditor(profileStore(), inquirerPrompter).run();
      }
      console.log(`\n${formatDoctor(await runDoctor())}`);
    }),
  );

// ─── doctor ─────────────────────────────────────────────
program
  .command('doctor')
  .description('준비 상태 점검: 내 정보, 검색 조건, Notion, 브라우저, AI 연결')
  .option('--ai', 'AI 에게 짧은 질문을 보내 실제로 답하는지도 확인한다 (사용량이 조금 듭니다)')
  .action(
    run(async (o: { ai?: boolean }) => {
      const checks = await runDoctor();
      console.log(formatDoctor(checks));
      if (o.ai && existsSync(paths.settings)) {
        console.log('\nAI 연결 확인 중…');
        const t = await testAi(loadSettings());
        console.log(`${t.ok ? '✅' : '❌'} ${t.message} (${(t.ms / 1000).toFixed(1)}초)`);
        if (!t.ok) process.exitCode = 1;
      }
      if (checks.some((c) => c.status === 'bad')) process.exitCode = 1;
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
      const ui = await startOrReuseUi(Number(opts.port));
      console.log(`✅ Auto-Job 설정 화면: ${ui.url}\n   ${ui.reused ? '이미 실행 중인 서버를 사용합니다. 진행 중인 작업은 그대로 유지됩니다.' : '(서버를 새로 시작할 때 주소가 바뀝니다. 끄려면 Ctrl+C)'}`);
      if (opts.open) openUrl(ui.url);
      if (!ui.reused) await waitForUiShutdown(ui.server);
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
  .command('import')
  .description('글을 붙여넣어 내 정보 채우기: AI 가 항목별로 나누고, 미리보기를 확인한 뒤 적용한다')
  .argument('[file]', '글 파일 (없으면 붙여넣은 뒤 Ctrl+D)')
  .action(
    run(async (file?: string) => {
      let text: string;
      if (file) text = readFileSync(file, 'utf8');
      else {
        if (process.stdin.isTTY) console.log('글을 붙여넣고, 다 됐으면 새 줄에서 Ctrl+D 를 누르세요.\n');
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        text = Buffer.concat(chunks).toString('utf8');
      }
      const store = profileStore();
      const settings = loadSettings();
      console.log('\nAI 가 정리하는 중… (1~2분)');
      const dir = runDir('profile-import');
      mkdirSync(dir, { recursive: true });
      const pv = await importProfileText(text, { settings, store, cwd: dir });
      const mark = { new: '＋', changed: '↻', same: '=' } as const;
      for (const [s, sec] of Object.entries(store.schema.sections)) {
        const cs = pv.changes.filter((c) => c.section === s);
        if (!cs.length) continue;
        console.log(`\n■ ${sec.label}`);
        for (const c of cs) console.log(`  ${mark[c.kind]} ${c.where.split(' > ').slice(1).join(' > ')}: ${c.after}${c.kind === 'changed' ? `   (지금: ${c.before})` : ''}${c.error ? `\n      ⚠️  ${c.error}` : ''}`);
      }
      if (pv.unknown.length) console.log(`\n항목에 없어 뺀 것: ${pv.unknown.join(', ')}`);
      const sections = Object.keys(pv.data);
      if (!sections.length && !pv.rules.length) return console.log('\n넣을 내용을 찾지 못했습니다.');
      const chosen = sections.length
        ? await inquirerPrompter.checkbox({ message: '적용할 섹션 (스페이스로 선택)', choices: sections.map((s) => ({ name: store.schema.sections[s].label, value: s, checked: true })) })
        : [];
      const rules = pv.rules.length
        ? await inquirerPrompter.checkbox({ message: '지원서 입력 규칙에 추가할 것', choices: pv.rules.map((r) => ({ name: r, value: r, checked: true })) })
        : [];
      const r = applyImport(store, pv.data, chosen);
      if (rules.length) settingsStore().addToList('apply.extra_rules', rules);
      console.log(`\n✅ ${r.written}개 칸을 채웠습니다${rules.length ? `, 규칙 ${rules.length}개 추가` : ''}.`);
      for (const x of r.skipped) console.log(`  ⚠️  넣지 않음: ${x}`);
      console.log('확인: autojob profile show --filled');
    }),
  );

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
  .command('fill')
  .description('지원서 작성 결과로 Notion 공고 페이지 본문을 채우고 제출 상태를 바꾼다 (이미 내용이 있는 섹션은 둠)')
  .argument('<page>', 'Notion 공고 페이지 주소')
  .argument('<run>', 'autojob apply 결과 폴더 (data/runs/…_apply-…)')
  .option('--no-status', '제출 상태는 바꾸지 않는다')
  .action(run(async (page: string, runDirPath: string, o: { status: boolean }) => {
    const file = path.join(runDirPath, 'report.json');
    if (!existsSync(file)) throw new Error(`${file} 이 없습니다`);
    const report = JSON.parse(readFileSync(file, 'utf8')) as ApplyReport;
    const id = parseNotionId(page);
    if (!id) throw new Error('Notion 페이지 주소에서 ID 를 찾지 못했습니다');
    const s = loadSettings();
    const client = notionClient();
    const content = buildPageContent({ essay: report.essay, formInfo: report.formInfo ?? null, role: report.role, uploads: report.actions.filter((a) => a.tool === 'upload' && a.ok).map((a) => a.value ?? '') });
    const results = await fillPageSections(client, id, content, s.notion.section_map);
    for (const r of results) console.log(`  ${r.status === 'filled' || r.status === 'added_heading' ? '📝 채움' : r.status === 'skipped_has_content' ? '⏭️  이미 내용이 있어 둠' : '·  넣을 내용 없음'}: ${r.title}`);
    if (o.status) console.log(`  ${await setSubmitStatus(client, id, s)}`);
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

// ─── 공고 수집 / 지원서 ─────────────────────────────────
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
program
  .command('apply')
  .description('지원서 작성: 로그인 대기(직접) → 인적사항 입력(AI) → 자기소개서 작성·입력(AI). 제출은 하지 않는다')
  .argument('<target>', 'Notion 공고 페이지 주소, 지원 페이지 주소, 또는 HTML 파일')
  .option('--no-wait', '로그인 대기 없이 바로 시작 (이미 입력 화면일 때)')
  .option('--steps <steps>', '할 단계, 쉼표로: basic(인적사항), essay(자기소개서)', 'basic,essay')
  .action(
    run(async (target: string, o: { wait: boolean; steps: string }) => {
      const steps = o.steps.split(',').map((s) => s.trim()).filter(Boolean);
      const bad = steps.filter((s) => s !== 'basic' && s !== 'essay');
      if (bad.length) throw new Error(`알 수 없는 단계: ${bad.join(', ')} (basic, essay 중에서)`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const report = await applyNow({ target, skipLoginWait: !o.wait, steps: steps as ApplyStep[], ask: (q) => rl.question(`\n${q}\n> `) });
        console.log(`\n${formatApplyReport(report)}\n\n리포트: ${report.dir}`);
      } finally {
        rl.close();
      }
    }),
  );

program
  .command('essay')
  .description('자기소개서만 쓴다 (브라우저 없이): 회사·직무 조사 → 전략 → 작성 → 검사 → 검토 → 고쳐 쓰기')
  .requiredOption('--company <name>', '회사명')
  .requiredOption('--questions <file>', '문항 파일 (한 문항씩 빈 줄로 구분, 글자수 제한은 "(700자 이내)" 처럼 적기)')
  .option('--role <role>', '지원 직무', '')
  .option('--posting <url>', '공고 주소 (있으면 AI 가 참고)')
  .action(
    run(async (o: { company: string; questions: string; role: string; posting?: string }) => {
      if (!existsSync(o.questions)) throw new Error(`문항 파일이 없습니다: ${o.questions}`);
      const questions = parseQuestionsText(readFileSync(o.questions, 'utf8'));
      if (!questions.length) throw new Error('문항을 찾지 못했습니다');
      console.log(`문항 ${questions.length}개: ${questions.map((q) => `${q.id}번${q.maxChars ? `(최대 ${q.maxChars})` : ''}`).join(', ')}`);
      const store = profileStore();
      const dir = runDir(`essay-${o.company.replace(/[^0-9A-Za-z가-힣]+/g, '_').slice(0, 30)}`);
      mkdirSync(dir, { recursive: true });
      const result = await writeEssays({ company: o.company, role: o.role, postingUrl: o.posting, questions }, { settings: loadSettings(), profile: store.toJSON(), schema: store.schema, cwd: dir, log: console.log });
      const md = formatEssays(result);
      writeFileSync(path.join(dir, 'essays.md'), md);
      console.log(`\n${md}\n\n저장: ${path.join(dir, 'essays.md')}`);
      notify('Auto-Job 자기소개서', result.ok ? '자기소개서를 다 썼습니다' : '검사 문제가 남아 있습니다 — 확인해 주세요');
    }),
  );

await program.parseAsync();
