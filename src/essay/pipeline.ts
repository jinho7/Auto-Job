// 자기소개서: 조사·전략·작성(AI) → 기계 검사 → 검토(AI) → 고쳐 쓰기(AI) → 글자수 등 남은 문제 고치기(AI)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Settings } from '../config';
import { extractJson, type AgentRun } from '../llm/claude-cli';
import { agentFor, modelFor } from '../llm';
import { paths } from '../paths';
import { renderProfileForAgent } from '../apply/profile-doc';
import type { ProfileSchema } from '../profile/schema';
import { blindTermsFromProfile, checkEssay, targetRange, UNIT_LABEL, type EssayCheck } from './checks';
import type { EssayAnswer, EssayQuestion, Research, Strategy } from './types';

export type Review = { id: number; verdict: 'ok' | 'revise'; unsupported_claims?: string[]; problems?: string[]; suggestions?: string[] };

export type EssayInput = { company: string; role: string; postingUrl?: string; questions: EssayQuestion[] };

export type EssayResult = {
  input: EssayInput;
  research?: Research;
  strategy: Strategy[];
  answers: EssayAnswer[];
  checks: EssayCheck[];
  reviews: Review[];
  rounds: number;
  /** reviews 가 마지막 고쳐 쓰기 전의 검토인지 (그렇다면 지적은 고쳐 쓰기에 반영됨) */
  reviewedBeforeLastRevision: boolean;
  costUsd: number;
  ok: boolean;
};

export type EssayDeps = {
  settings: Settings;
  profile: Record<string, unknown>;
  schema: ProfileSchema;
  cwd: string;
  log?: (m: string) => void;
  /** 테스트에서 가짜 AI 로 바꿀 수 있게 */
  runAgent?: (o: AgentRun) => Promise<{ text: string; isError: boolean; costUsd?: number }>;
};

const WEB = ['WebSearch', 'WebFetch'];

export function styleRules(e: Settings['essay'], blindTerms: string[]): string {
  const lines = [`- 문장 끝맺음: '~${e.tone.replace(/^~/, '')}' 체`];
  if (e.subtitle) lines.push('- 문단마다 내용이 한눈에 드러나는 [소제목]을 첫 줄에 답니다. [지원동기] 같은 항목 이름 말고, 그 문단의 내용을 요약한 짧은 제목으로 씁니다.');
  if (e.forbid_middle_dot) lines.push('- 단어를 나열할 때 가운뎃점(·)을 쓰지 않습니다.');
  if (e.blind) {
    lines.push('- 블라인드 규정: 실명, 학교명, 특정 동아리·단체명, 직접 만든 서비스 이름처럼 나를 특정할 수 있는 고유명사는 쓰지 않습니다 (예: "OO 관련 동아리", "일정 관리 서비스").');
    if (blindTerms.length) lines.push(`  특히 다음 단어는 쓰지 마세요: ${blindTerms.join(', ')}`);
  }
  if (e.banned_phrases.length) lines.push(`- 다음 표현은 쓰지 않습니다: ${e.banned_phrases.map((p) => `"${p}"`).join(', ')}`);
  return `## 사용자 문체 규칙\n${lines.join('\n')}`;
}

export function questionList(qs: EssayQuestion[]): string {
  return qs
    .map((q) => {
      const r = targetRange(q);
      const limit = q.maxChars || q.minChars ? ` [${q.minChars ? `최소 ${q.minChars}` : ''}${q.minChars && q.maxChars ? ' ~ ' : ''}${q.maxChars ? `최대 ${q.maxChars}` : ''}${UNIT_LABEL[q.unit]}${r && q.maxChars ? `, 목표 ${r.min}~${r.max}` : ''}]` : ' [글자수 제한 없음]';
      return `${q.id}. ${q.question}${limit}${q.note ? ` (참고: ${q.note})` : ''}`;
    })
    .join('\n');
}

const prompt = (name: string) => readFileSync(path.join(paths.prompts, name), 'utf8');

export async function writeEssays(input: EssayInput, d: EssayDeps): Promise<EssayResult> {
  const log = d.log ?? (() => {});
  const run = d.runAgent ?? agentFor(d.settings);
  const e = d.settings.essay;
  const blind = e.blind ? blindTermsFromProfile(d.profile as Record<string, any>) : [];
  const style = styleRules(e, blind);
  const profileDoc = renderProfileForAgent(d.profile, d.schema);
  const model = modelFor(d.settings, e.model);
  let cost = 0;
  const agent = async (system: string, userPrompt: string, tools: string[]) => {
    const r = await run({ prompt: userPrompt, systemAppend: system, tools, model, cwd: d.cwd, onEvent: (ev) => ev.type === 'tool' && log(`   🔎 ${ev.name} ${String(ev.input.query ?? ev.input.url ?? '').slice(0, 80)}`) });
    cost += r.costUsd ?? 0;
    if (r.isError) throw new Error(r.text);
    return r.text;
  };
  const header = [
    `지원 회사: ${input.company || '(모름)'}`,
    `지원 직무: ${input.role || '(모름)'}`,
    input.postingUrl ? `공고/지원 페이지: ${input.postingUrl}` : '',
  ].filter(Boolean).join('\n');
  const byId = new Map(input.questions.map((q) => [q.id, q]));
  const runChecks = (answers: EssayAnswer[]) => answers.map((a) => checkEssay(byId.get(a.id)!, a, e, blind));
  const complete = (answers: EssayAnswer[] | undefined, prev: EssayAnswer[] = []): EssayAnswer[] => {
    const got = new Map((answers ?? []).filter((a) => byId.has(a.id) && typeof a.text === 'string').map((a) => [a.id, a.text]));
    return input.questions.map((q) => ({ id: q.id, text: got.get(q.id) ?? prev.find((p) => p.id === q.id)?.text ?? '' }));
  };

  // 1. 조사 → 전략 → 작성
  log('④ 자기소개서: 회사·직무 조사, 전략, 작성');
  const draftText = await agent(
    `${prompt('essay-write.md')}\n\n${style}`,
    [header, '', '## 자기소개서 문항', questionList(input.questions), '', '## 내 정보와 자소서 소재', profileDoc].join('\n'),
    WEB,
  );
  const draft = extractJson<{ research?: Research; strategy?: Strategy[]; answers?: EssayAnswer[] }>(draftText);
  let answers = complete(draft.answers);
  let checks = runChecks(answers);
  let reviews: Review[] = [];
  let rounds = 0;
  let reviewedBeforeLastRevision = false;
  const researchDoc = draft.research
    ? `회사 요약: ${draft.research.company_summary}\n인재상/가치: ${draft.research.values?.join(', ')}\n최근 소식: ${draft.research.recent?.join(' / ')}\n직무: ${draft.research.role}\n출처: ${draft.research.sources?.join(', ')}`
    : '(조사 결과 없음)';
  const answersDoc = (as: EssayAnswer[]) => as.map((a) => `### ${a.id}\n${a.text}`).join('\n\n');
  const checksDoc = (cs: EssayCheck[]) =>
    cs.map((c) => `${c.id}. ${c.length}자 ${c.issues.length ? `문제: ${c.issues.join(' / ')}` : '문제 없음'}${c.warnings.length ? ` / 참고: ${c.warnings.join(' / ')}` : ''}`).join('\n');

  // 2. 검토 → 고쳐 쓰기
  for (let i = 0; i < e.max_revisions; i++) {
    log(`   🧐 검토 ${i + 1}회차`);
    const reviewText = await agent(
      `${prompt('essay-review.md')}\n\n${style}`,
      [header, '', '## 문항', questionList(input.questions), '', '## 초안', answersDoc(answers), '', '## 기계 검사 결과', checksDoc(checks), '', '## 작성자가 조사한 회사 정보', researchDoc, '', '## 내 정보와 자소서 소재 (사실 확인용)', profileDoc].join('\n'),
      WEB,
    );
    reviews = extractJson<{ reviews?: Review[] }>(reviewText).reviews ?? [];
    const needs = reviews.some((r) => r.verdict === 'revise' || r.unsupported_claims?.length) || checks.some((c) => c.issues.length);
    reviewedBeforeLastRevision = needs;
    if (!needs) break;
    rounds++;
    log(`   ✍️  고쳐 쓰기 ${rounds}회차`);
    const revText = await agent(
      `${prompt('essay-write.md')}\n\n${style}\n\n## 지금 할 일\n검토 의견과 기계 검사 결과를 반영해 답변을 고쳐 씁니다. 조사는 이미 했으니 필요할 때만 확인하세요. 지어낸 내용으로 지적된 부분은 반드시 빼거나 내 정보에 있는 사실로 바꿉니다. 출력 JSON 에는 answers 만 넣어도 됩니다 (모든 문항).`,
      [header, '', '## 문항', questionList(input.questions), '', '## 현재 답변', answersDoc(answers), '', '## 검토 의견', JSON.stringify(reviews, null, 1), '', '## 기계 검사 결과', checksDoc(checks), '', '## 회사 조사', researchDoc, '', '## 내 정보와 자소서 소재', profileDoc].join('\n'),
      WEB,
    );
    answers = complete(extractJson<{ answers?: EssayAnswer[] }>(revText).answers, answers);
    checks = runChecks(answers);
  }

  // 3. 남은 기계 검사 문제(글자수 등)만 고치기
  for (let i = 0; i < 2 && checks.some((c) => c.issues.length); i++) {
    const bad = checks.filter((c) => c.issues.length);
    log(`   🔧 검사 문제 고치기: ${bad.map((c) => `${c.id}번(${c.issues[0]})`).join(', ')}`);
    const fixText = await agent(
      `${style}\n\n당신은 자기소개서 답변의 형식 문제만 고칩니다. 내용과 사실은 바꾸지 말고, 지적된 문제만 고치세요. 결과는 {"answers":[{"id":…,"text":"…"}]} JSON 을 \`\`\`json 블록으로 출력합니다.`,
      [
        '## 고칠 답변',
        ...bad.map((c) => {
          const q = byId.get(c.id)!;
          const r = targetRange(q);
          return `### ${c.id}. ${q.question}\n문제: ${c.issues.join(' / ')}${r ? `\n목표 분량: ${r.min}~${r.max}${UNIT_LABEL[q.unit]} (현재 ${c.length})` : ''}\n\n${answers.find((a) => a.id === c.id)?.text ?? ''}`;
        }),
      ].join('\n\n'),
      [],
    );
    answers = complete(extractJson<{ answers?: EssayAnswer[] }>(fixText).answers, answers);
    checks = runChecks(answers);
  }

  return {
    input,
    research: draft.research,
    strategy: draft.strategy ?? [],
    answers,
    checks,
    reviews,
    rounds,
    reviewedBeforeLastRevision,
    costUsd: cost,
    ok: checks.every((c) => !c.issues.length) && answers.every((a) => a.text.trim()),
  };
}

export function formatEssays(r: EssayResult): string {
  const out: string[] = [`# 자기소개서 — ${[r.input.company, r.input.role].filter(Boolean).join(' ') || '(회사 모름)'}`, ''];
  if (r.research) {
    out.push('## 회사 조사', r.research.company_summary, '');
    if (r.research.values?.length) out.push(`- 인재상/가치: ${r.research.values.join(', ')}`);
    if (r.research.recent?.length) out.push(`- 최근 소식: ${r.research.recent.join(' / ')}`);
    if (r.research.role) out.push(`- 직무: ${r.research.role}`);
    if (r.research.sources?.length) out.push(`- 출처: ${r.research.sources.join(' , ')}`);
    out.push('');
  }
  for (const q of r.input.questions) {
    const a = r.answers.find((x) => x.id === q.id);
    const c = r.checks.find((x) => x.id === q.id);
    const s = r.strategy.find((x) => x.id === q.id);
    out.push(`## ${q.id}. ${q.question}`);
    out.push(`> ${c ? `${c.length}${UNIT_LABEL[q.unit]}` : ''}${q.maxChars ? ` / 최대 ${q.maxChars}` : ''}${s ? ` · 소재: ${s.stories.join(', ')}` : ''}`);
    for (const i of c?.issues ?? []) out.push(`> ❌ ${i}`);
    for (const w of c?.warnings ?? []) out.push(`> ⚠️ ${w}`);
    out.push('', a?.text ?? '(없음)', '');
  }
  const flagged = r.reviews.filter((v) => v.unsupported_claims?.length);
  if (flagged.length) {
    out.push(
      r.reviewedBeforeLastRevision
        ? '## 검토에서 근거 없다고 지적되어 고쳐 쓴 내용 (최종 답변에 남아 있지 않은지 한 번 더 확인하세요)'
        : '## 검토에서 근거 없다고 지적된 내용 (고쳐 쓰지 않음 — 직접 확인이 필요합니다)',
    );
    for (const v of flagged) out.push(`- ${v.id}번: ${v.unsupported_claims!.join(' / ')}`);
    out.push('');
  }
  out.push(`> 고쳐 쓰기 ${r.rounds}회${r.costUsd ? ` · AI 사용량 $${r.costUsd.toFixed(3)}` : ''}${r.ok ? '' : ' · ⚠️ 해결하지 못한 검사 문제가 있습니다'}`);
  return out.join('\n');
}
