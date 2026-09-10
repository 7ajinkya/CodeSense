import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { Problem } from '../problems/problem';
import { problemLabel } from '../problems/problem';
import type { ProblemKnowledgeRecord } from './problemKnowledge';

/**
 * Phase J-1 knowledge table: deterministic Markdown projection over the
 * canonical sources (Problem + ProblemKnowledgeRecord).
 *
 * Boundary notes:
 * - The renderer is a projection only. The canonical sources remain the
 *   `Problem` row and the `ProblemKnowledgeRecord` row; J-0 derived
 *   statistics are NOT duplicated here (a later stage may join them).
 * - J-0's frozen Markdown output is left untouched — this is a separate
 *   additive renderer, so no frozen behavior changes.
 * - Missing knowledge renders as an absence marker (`—`), never as
 *   "not learned" and never as invented values. Entity cells show live
 *   graph display names with the stable ID as fallback.
 * - Pure: same inputs always yield byte-identical Markdown. Rows sort by
 *   `problemId`; inputs are never mutated. No H/AI/network involvement.
 */

const ABSENT = '—';

export const KNOWLEDGE_TABLE_HEADER =
  '| Problem | Link | Concepts | Forms | Frameworks | Tactics | Debug | Key Insight |';

/** Escape a cell so learner-authored text cannot break the table layout. */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function namesFor(ids: string[], graph: KnowledgeGraph): string {
  if (ids.length === 0) {
    return ABSENT;
  }
  return ids.map((id) => graph.getEntity(id)?.name ?? id).join(', ');
}

function textFor(value: string | null): string {
  if (value === null || value.length === 0) {
    return ABSENT;
  }
  return value;
}

/**
 * Render one Markdown knowledge-table row per canonical problem (sorted by
 * `problemId`). Problems without a knowledge record show absence markers
 * in every knowledge column — the absence of a record is visible rather
 * than ambiguous, and nothing is invented for it.
 */
export function renderKnowledgeTable(args: {
  problems: Problem[];
  records: ProblemKnowledgeRecord[];
  graph: KnowledgeGraph;
}): string {
  const byProblem = new Map<string, ProblemKnowledgeRecord>();
  for (const record of args.records) {
    byProblem.set(record.problemId, record);
  }
  const ordered = args.problems.slice().sort((a, b) => a.problemId.localeCompare(b.problemId));
  const lines: string[] = [];
  lines.push('# CodeSense Problem Knowledge (J-1 projection)');
  lines.push('');
  lines.push(
    'Learner-controlled knowledge per canonical problem. ' +
      'Attempt statistics stay derived in J-0 and are not duplicated here.',
  );
  lines.push('');
  lines.push(KNOWLEDGE_TABLE_HEADER);
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  if (ordered.length === 0) {
    lines.push(`| _No problems recorded._ | ${ABSENT} | ${ABSENT} | ${ABSENT} | ${ABSENT} | ${ABSENT} | ${ABSENT} | ${ABSENT} |`);
    lines.push('');
    return lines.join('\n');
  }
  for (const problem of ordered) {
    const record = byProblem.get(problem.problemId) ?? null;
    lines.push(
      `| ${escapeCell(problemLabel(problem))} | ${escapeCell(problem.canonicalUrl)} | ` +
        `${escapeCell(record ? namesFor(record.conceptIds, args.graph) : ABSENT)} | ` +
        `${escapeCell(record ? namesFor(record.formIds, args.graph) : ABSENT)} | ` +
        `${escapeCell(record ? namesFor(record.frameworkIds, args.graph) : ABSENT)} | ` +
        `${escapeCell(record ? namesFor(record.tacticIds, args.graph) : ABSENT)} | ` +
        `${escapeCell(record ? textFor(record.debugNotes) : ABSENT)} | ` +
        `${escapeCell(record ? textFor(record.keyInsight) : ABSENT)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}
