import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDefaultKnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import type { KnowledgeGraph } from 'codesense/knowledge/ontologyStore';
import { createManualProblem } from 'codesense/problems/problem';
import type { Problem } from 'codesense/problems/problem';
import {
  completeAttempt,
  createAttempt,
  transitionAttemptState,
} from 'codesense/attempts/attempt';
import {
  MAX_KNOWLEDGE_TEXT_CHARS,
  createProblemKnowledge,
  parseProblemKnowledge,
  problemKnowledgeIdFor,
  updateProblemKnowledge,
} from 'codesense/longterm/problemKnowledge';
import { LocalProblemKnowledgeStore } from 'codesense/longterm/problemKnowledgeStore';
import {
  KNOWLEDGE_TABLE_HEADER,
  renderKnowledgeTable,
} from 'codesense/longterm/knowledgeTable';
import { deriveProblemStats } from 'codesense/longterm/problemStats';
import { LocalLearnerEvidenceStore } from 'codesense/learner/learnerEvidenceStore';
import { LocalGoalStore } from 'codesense/goals/goalStore';
import { LocalActivityPlanStore } from 'codesense/practice/activityStore';
import { LocalProgressStore } from 'codesense/progress/progressStore';
import { LocalReflectionStore } from 'codesense/reflection/reflectionStore';
import * as problemKnowledgeModule from 'codesense/longterm/problemKnowledge';

/**
 * Phase J-1 — Problem Knowledge Record / learner notes.
 * Durable learner-controlled knowledge per canonical problem. No AI.
 */

const CONCEPT = 'concept.monotonicity';
const CONCEPT_2 = 'concept.invariants';
const FORM = 'form.search-on-answer';
const FRAMEWORK = 'framework.binary-search';
const TACTIC = 'tactic.visited-on-enqueue';

const URL = 'https://leetcode.com/problems/two-sum/';
const NOW = '2026-05-01T10:00:00.000Z';
const LATER = '2026-06-01T10:00:00.000Z';

let graph: KnowledgeGraph;

function makeProblem(): Problem {
  return createManualProblem(URL, { title: 'Two Sum', statement: 'Solve Two Sum.' }, NOW);
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codesense-j1-'));
}

function listStoreFiles(workspace: string): string[] {
  const dir = path.join(workspace, '.codesense');
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir).sort();
}

function snapshotStoreFiles(workspace: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const file of listStoreFiles(workspace)) {
    try {
      out.set(file, fs.readFileSync(path.join(workspace, '.codesense', file), 'utf-8'));
    } catch {
      out.set(file, null);
    }
  }
  return out;
}

describe('Phase J-1 — problem knowledge record', () => {
  before(() => {
    graph = getDefaultKnowledgeGraph();
    expect(graph.hasEntity(CONCEPT)).to.equal(true);
    expect(graph.hasEntity(CONCEPT_2)).to.equal(true);
    expect(graph.hasEntity(FORM)).to.equal(true);
    expect(graph.hasEntity(FRAMEWORK)).to.equal(true);
    expect(graph.hasEntity(TACTIC)).to.equal(true);
  });

  it('A. creates a valid knowledge record', () => {
    const record = createProblemKnowledge({
      problem: makeProblem(),
      graph,
      input: {
        conceptIds: [CONCEPT],
        formIds: [FORM],
        frameworkIds: [FRAMEWORK],
        tacticIds: [TACTIC],
        debugNotes: 'Off-by-one on the right boundary.',
        keyInsight: 'The predicate flips exactly once.',
        learnerNotes: 'Remember to prove monotonicity first.',
      },
      now: NOW,
    });
    expect(record.problemId).to.equal(makeProblem().problemId);
    expect(record.recordId).to.equal(problemKnowledgeIdFor(record.problemId));
    expect(record.conceptIds).to.deep.equal([CONCEPT]);
    expect(record.formIds).to.deep.equal([FORM]);
    expect(record.frameworkIds).to.deep.equal([FRAMEWORK]);
    expect(record.tacticIds).to.deep.equal([TACTIC]);
    expect(record.debugNotes).to.equal('Off-by-one on the right boundary.');
    expect(record.keyInsight).to.equal('The predicate flips exactly once.');
    expect(record.learnerNotes).to.equal('Remember to prove monotonicity first.');
    expect(record.provenance.source).to.equal('learner-authored');
    expect(record.createdAt).to.equal(NOW);
    expect(record.updatedAt).to.equal(NOW);
  });

  it('B+C. persists and reads back; update keeps one record', async () => {
    const workspace = makeWorkspace();
    const store = new LocalProblemKnowledgeStore(workspace);
    const problem = makeProblem();
    await store.upsertKnowledge(
      createProblemKnowledge({ problem, graph, input: { keyInsight: 'First insight.' }, now: NOW }),
    );
    const read = await store.getKnowledgeForProblem(problem.problemId);
    expect(read?.keyInsight).to.equal('First insight.');
    await store.upsertKnowledge(updateProblemKnowledge(read!, { keyInsight: 'Deeper insight.' }, graph, LATER));
    const listed = await store.listKnowledge();
    expect(listed.length).to.equal(1);
    expect(listed[0]!.keyInsight).to.equal('Deeper insight.');
    expect(listed[0]!.recordId).to.equal(read!.recordId);
    expect(listed[0]!.createdAt).to.equal(NOW);
    expect(listed[0]!.updatedAt).to.equal(LATER);
  });

  it('D. restart/reload recovers the same record', async () => {
    const workspace = makeWorkspace();
    const problem = makeProblem();
    const original = createProblemKnowledge({
      problem,
      graph,
      input: { conceptIds: [CONCEPT], debugNotes: 'Watch the bounds.', keyInsight: 'Invariant holds.' },
      now: NOW,
    });
    await new LocalProblemKnowledgeStore(workspace).upsertKnowledge(original);
    // Fresh store instance = restart (fresh reads, no cache).
    const reloaded = await new LocalProblemKnowledgeStore(workspace).getKnowledgeForProblem(problem.problemId);
    expect(reloaded).to.deep.equal(original);
  });

  it('E. deterministic record identity, stable across updates', () => {
    const problem = makeProblem();
    expect(problemKnowledgeIdFor(problem.problemId)).to.equal(`pk_${problem.problemId}`);
    const first = createProblemKnowledge({ problem, graph, input: {}, now: NOW });
    const second = createProblemKnowledge({ problem, graph, input: { keyInsight: 'x' }, now: LATER });
    expect(first.recordId).to.equal(second.recordId);
    const updated = updateProblemKnowledge(first, { learnerNotes: 'n' }, graph, LATER);
    expect(updated.recordId).to.equal(first.recordId);
    expect(updated.problemId).to.equal(first.problemId);
  });

  it('F. duplicate entity IDs normalize deterministically (dedupe + sort)', () => {
    const record = createProblemKnowledge({
      problem: makeProblem(),
      graph,
      input: { conceptIds: [CONCEPT_2, CONCEPT, CONCEPT, CONCEPT_2] },
      now: NOW,
    });
    expect(record.conceptIds).to.deep.equal([CONCEPT, CONCEPT_2].sort());
  });

  it('G. unknown Concept ID rejected', () => {
    expect(() =>
      createProblemKnowledge({ problem: makeProblem(), graph, input: { conceptIds: ['concept.nope-missing'] }, now: NOW }),
    ).to.throw();
  });

  it('H. Concept ID placed in Forms rejected (no silent reinterpretation)', () => {
    expect(() =>
      createProblemKnowledge({ problem: makeProblem(), graph, input: { formIds: [CONCEPT] }, now: NOW }),
    ).to.throw();
    expect(() =>
      createProblemKnowledge({ problem: makeProblem(), graph, input: { conceptIds: [FORM] }, now: NOW }),
    ).to.throw();
    expect(() =>
      createProblemKnowledge({ problem: makeProblem(), graph, input: { tacticIds: [FRAMEWORK] }, now: NOW }),
    ).to.throw();
  });

  it('I. unknown Form/Framework/Tactic IDs rejected', () => {
    for (const input of [
      { formIds: ['form.nope-missing'] },
      { frameworkIds: ['framework.nope-missing'] },
      { tacticIds: ['tactic.nope-missing'] },
    ]) {
      expect(() => createProblemKnowledge({ problem: makeProblem(), graph, input, now: NOW })).to.throw();
    }
  });

  it('J. invalid problemId rejected', () => {
    expect(() =>
      createProblemKnowledge({
        problem: { problemId: '   ' } as Problem,
        graph,
        input: {},
        now: NOW,
      }),
    ).to.throw();
    expect(parseProblemKnowledge({ schemaVersion: 1 })).to.equal(null);
    expect(parseProblemKnowledge(null)).to.equal(null);
    expect(parseProblemKnowledge('pk_x')).to.equal(null);
  });

  it('K. oversized text rejected', () => {
    const big = 'x'.repeat(MAX_KNOWLEDGE_TEXT_CHARS + 1);
    for (const input of [{ debugNotes: big }, { keyInsight: big }, { learnerNotes: big }]) {
      expect(() => createProblemKnowledge({ problem: makeProblem(), graph, input, now: NOW })).to.throw();
    }
    const ok = 'y'.repeat(MAX_KNOWLEDGE_TEXT_CHARS);
    const record = createProblemKnowledge({
      problem: makeProblem(),
      graph,
      input: { keyInsight: ok },
      now: NOW,
    });
    expect(record.keyInsight?.length).to.equal(MAX_KNOWLEDGE_TEXT_CHARS);
  });

  it('L. empty/invalid structured values handled safely', () => {
    const record = createProblemKnowledge({ problem: makeProblem(), graph, input: {}, now: NOW });
    expect(record.conceptIds).to.deep.equal([]);
    expect(record.debugNotes).to.equal(null);
    for (const bad of [
      { conceptIds: ['  '] },
      { conceptIds: [42] },
      { conceptIds: 'concept.monotonicity' },
      { formIds: [null] },
      { debugNotes: 42 },
      { source: 'ai-overlord' },
    ]) {
      expect(() => createProblemKnowledge({ problem: makeProblem(), graph, input: bad, now: NOW })).to.throw();
    }
  });

  it('M. learner-notes normalization contract (trim, exact interior, empty→null)', () => {
    const record = createProblemKnowledge({
      problem: makeProblem(),
      graph,
      input: {
        learnerNotes: '  line one\n  line   two  ',
        debugNotes: '   ',
        keyInsight: '',
      },
      now: NOW,
    });
    expect(record.learnerNotes).to.equal('line one\n  line   two');
    expect(record.debugNotes).to.equal(null);
    expect(record.keyInsight).to.equal(null);
  });

  it('N+O. debug notes and key insight persist', async () => {
    const workspace = makeWorkspace();
    const store = new LocalProblemKnowledgeStore(workspace);
    const problem = makeProblem();
    await store.upsertKnowledge(
      createProblemKnowledge({
        problem,
        graph,
        input: { debugNotes: 'Print the window on shrink.', keyInsight: 'Shrink restores validity.' },
        now: NOW,
      }),
    );
    const read = await store.getKnowledgeForProblem(problem.problemId);
    expect(read?.debugNotes).to.equal('Print the window on shrink.');
    expect(read?.keyInsight).to.equal('Shrink restores validity.');
  });

  it('P. same problem across many attempts still maps to one record', async () => {
    const workspace = makeWorkspace();
    const store = new LocalProblemKnowledgeStore(workspace);
    const problem = makeProblem();
    const attempts = [0, 1, 2, 3].map((n) =>
      createAttempt({
        attemptId: `att_p${n}`,
        problemId: problem.problemId,
        sessionId: `ses_${n}`,
        startedAt: `2026-0${n + 1}-01T10:00:00.000Z`,
      }),
    );
    transitionAttemptState(attempts[0]!, 'Got WA', 'learner', { timestamp: '2026-01-01T10:20:00.000Z' });
    completeAttempt(attempts[0]!, '2026-01-01T10:20:00.000Z');
    for (const n of [1, 2, 3]) {
      transitionAttemptState(attempts[n]!, 'Got AC Independently', 'learner', {
        timestamp: `2026-0${n + 1}-01T10:20:00.000Z`,
      });
      completeAttempt(attempts[n]!, `2026-0${n + 1}-01T10:20:00.000Z`);
    }
    expect(new Set(attempts.map((a) => a.problemId)).size).to.equal(1);
    await store.upsertKnowledge(
      createProblemKnowledge({ problem, graph, input: { keyInsight: 'After attempt 2.' }, now: NOW }),
    );
    const current = await store.getKnowledgeForProblem(problem.problemId);
    await store.upsertKnowledge(updateProblemKnowledge(current!, { keyInsight: 'After revisit.' }, graph, LATER));
    expect((await store.listKnowledge()).length).to.equal(1);
    // J-0 stats still derive every attempt/solve independently of the record.
    const stats = deriveProblemStats([problem], attempts);
    expect(stats[0]!.timesAttempted).to.equal(4);
    expect(stats[0]!.timesSolved).to.equal(3);
  });

  it('Q+R+S+T. knowledge writes touch no D/F/G/C state', async () => {
    const workspace = makeWorkspace();
    const evidence = new LocalLearnerEvidenceStore(workspace);
    const goals = new LocalGoalStore(workspace);
    const plans = new LocalActivityPlanStore(workspace);
    const progress = new LocalProgressStore(workspace);
    const reflections = new LocalReflectionStore(workspace);
    const knowledge = new LocalProblemKnowledgeStore(workspace);
    expect(await evidence.listEvidence()).to.deep.equal([]);
    const before = snapshotStoreFiles(workspace);
    const problem = makeProblem();
    await knowledge.upsertKnowledge(
      createProblemKnowledge({ problem, graph, input: { conceptIds: [CONCEPT], keyInsight: 'k' }, now: NOW }),
    );
    const current = await knowledge.getKnowledgeForProblem(problem.problemId);
    await knowledge.upsertKnowledge(updateProblemKnowledge(current!, { learnerNotes: 'n' }, graph, LATER));
    expect(await evidence.listEvidence()).to.deep.equal([]);
    expect(await goals.listGoals()).to.deep.equal([]);
    expect(await plans.listPlans()).to.deep.equal([]);
    expect(await progress.listProgress()).to.deep.equal([]);
    expect(await reflections.listReflections()).to.deep.equal([]);
    const after = snapshotStoreFiles(workspace);
    // Only the knowledge file may appear/change; every other file is byte-identical.
    for (const [file, content] of before) {
      expect(after.get(file)).to.equal(content);
    }
    for (const [file] of after) {
      if (!before.has(file)) {
        expect(file).to.equal('problem-knowledge.json');
      }
    }
    // The C graph is unchanged and still resolves the linked entities.
    expect(graph.getEntity(CONCEPT)?.type).to.equal('concept');
    expect(graph.getEntity(FORM)?.type).to.equal('form');
  });

  it('U. no AI required — module surface is deterministic only', () => {
    const keys = Object.keys(problemKnowledgeModule).sort();
    expect(keys).to.not.contain('reasoner');
    expect(keys.join(' ').toLowerCase()).to.not.contain('ai');
    expect(keys.join(' ').toLowerCase()).to.not.contain('refine');
    expect(keys.join(' ').toLowerCase()).to.not.contain('evidence');
  });

  it('V. table shows name, link, concepts, forms, frameworks, tactics, debug, insight', () => {
    const problem = makeProblem();
    const record = createProblemKnowledge({
      problem,
      graph,
      input: {
        conceptIds: [CONCEPT],
        formIds: [FORM],
        frameworkIds: [FRAMEWORK],
        tacticIds: [TACTIC],
        debugNotes: 'Off-by-one on the right boundary.',
        keyInsight: 'The predicate flips exactly once.',
      },
      now: NOW,
    });
    const rendered = renderKnowledgeTable({ problems: [problem], records: [record], graph });
    expect(rendered).to.contain(KNOWLEDGE_TABLE_HEADER);
    expect(rendered).to.contain('Two Sum');
    expect(rendered).to.contain(problem.canonicalUrl);
    expect(rendered).to.contain('Monotonicity');
    expect(rendered).to.contain('Binary Search on Answer');
    expect(rendered).to.contain('Binary Search');
    expect(rendered).to.contain('Mark Visited on Enqueue');
    expect(rendered).to.contain('Off-by-one on the right boundary.');
    expect(rendered).to.contain('The predicate flips exactly once.');
  });

  it('W. table invents no missing knowledge (absence markers, no "not learned")', () => {
    const problem = makeProblem();
    const rendered = renderKnowledgeTable({ problems: [problem], records: [], graph });
    expect(rendered).to.contain('Two Sum');
    expect(rendered).to.contain('—');
    expect(rendered.toLowerCase()).to.not.contain('not learned');
    // A record with only an insight leaves every other column absent.
    const partial = createProblemKnowledge({
      problem,
      graph,
      input: { keyInsight: 'Only this.' },
      now: NOW,
    });
    const renderedPartial = renderKnowledgeTable({ problems: [problem], records: [partial], graph });
    expect(renderedPartial).to.contain('Only this.');
    const row = renderedPartial.split('\n').find((line) => line.startsWith('| Two Sum'))!;
    expect(row!.split('|').filter((cell) => cell.trim() === '—').length).to.be.greaterThan(0);
  });

  it('X. table rendering is deterministic', () => {
    const a = makeProblem();
    const b = createManualProblem('https://leetcode.com/problems/reverse-string/', {
      title: 'Reverse String',
      statement: 'Solve Reverse String.',
    }, NOW);
    const records = [
      createProblemKnowledge({ problem: b, graph, input: { keyInsight: 'Two ends.' }, now: NOW }),
      createProblemKnowledge({ problem: a, graph, input: { conceptIds: [CONCEPT] }, now: NOW }),
    ];
    const first = renderKnowledgeTable({ problems: [b, a], records, graph });
    const second = renderKnowledgeTable({ problems: [a, b], records: [records[1]!, records[0]!], graph });
    expect(second).to.equal(first);
    expect(renderKnowledgeTable({ problems: [], records: [], graph })).to.contain('No problems recorded');
  });

  it('Y. J-0 statistics are not duplicated into the knowledge record', () => {
    const record = createProblemKnowledge({
      problem: makeProblem(),
      graph,
      input: { conceptIds: [CONCEPT], keyInsight: 'k' },
      now: NOW,
    });
    for (const field of ['timesAttempted', 'timesSolved', 'firstAttemptedAt', 'lastSolvedAt', 'attemptIds']) {
      expect(record).to.not.have.property(field);
    }
    expect(JSON.stringify(record)).to.not.contain('timesAttempted');
  });

  it('Z. inputs and source objects are not mutated', () => {
    const problem = makeProblem();
    const input = { conceptIds: [CONCEPT_2, CONCEPT], keyInsight: '  keep me  ' };
    const before = JSON.stringify({ problem, input });
    const created = createProblemKnowledge({ problem, graph, input, now: NOW });
    expect(JSON.stringify({ problem, input })).to.equal(before);
    expect(input.conceptIds).to.deep.equal([CONCEPT_2, CONCEPT]);
    const createdBefore = JSON.stringify(created);
    updateProblemKnowledge(created, { keyInsight: 'changed' }, graph, LATER);
    expect(JSON.stringify(created)).to.equal(createdBefore);
  });

  it('malformed persisted rows fail safely (never break loading)', async () => {
    const workspace = makeWorkspace();
    const problem = makeProblem();
    const store = new LocalProblemKnowledgeStore(workspace);
    await store.upsertKnowledge(createProblemKnowledge({ problem, graph, input: { keyInsight: 'k' }, now: NOW }));
    const file = path.join(workspace, '.codesense', 'problem-knowledge.json');
    const rows = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown[];
    rows.push(
      { nonsense: true },
      { recordId: 'pk_x', problemId: '', schemaVersion: 1 },
      'not-a-record',
      42,
    );
    fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    // Lenient reads: garbage rows are skipped, the sound row still loads.
    const listed = await new LocalProblemKnowledgeStore(workspace).listKnowledge();
    expect(listed.length).to.equal(1);
    expect(listed[0]!.keyInsight).to.equal('k');
    expect(parseProblemKnowledge({ nonsense: true })).to.equal(null);
    // Strict writes: malformed records throw instead of persisting.
    let threw = false;
    try {
      await store.upsertKnowledge({ nonsense: true } as never);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
