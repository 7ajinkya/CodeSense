import { Attempt } from '../attempts/attempt';
import { CodeEditRecord, selectAttemptEdits, tryReconstructSource } from '../history/codeHistory';
import { CodeCheckpoint, attemptBaseline } from '../history/checkpoints';
import { computeLineDiff, formatTextDiff } from '../history/textDiff';
import { ActivityEvent } from '../events/activityEvent';
import { Problem } from '../problems/problem';
import { AIConversationMessage } from '../ai/aiTypes';
import { ProblemClassification } from '../knowledge/classification';
import type { CoachContext } from '../coach/coachTypes';

export const AI_CONTEXT_VERSION = 2;
export const MAX_RECENT_EDITS = 100;
export const MAX_EXECUTIONS = 50;
export const MAX_CHECKPOINT_SNAPSHOTS = 3;
/** Newest checkpoint pairs rendered as derived human-readable diffs. */
export const MAX_EVOLUTION_PAIRS = 4;
/** Per-pair cap on derived diff text (display aid, never canonical storage). */
export const MAX_EVOLUTION_DIFF_CHARS = 4000;
/** Conversation tail included so replies become future context. */
export const MAX_CONVERSATION_MESSAGES = 20;

/**
 * Phase 1 prepares the FUTURE AI layer's input without implementing any AI.
 * This builder deliberately assembles a scoped context for the ACTIVE attempt
 * only — never a raw `sessions.json` dump (§34–§35):
 *
 *   problem (resolved BEFORE coding started) + attempt + state history +
 *   current code + recent evolution + checkpoints + local execution/test/
 *   error evidence + previous attempts on the same problem.
 */

export interface AIContextProblem {
  problemId: string;
  provider: string;
  providerId: string | null;
  canonicalUrl: string;
  title: string | null;
  statement: string | null;
  constraints: string | null;
  examples: Problem['examples'];
  difficulty: string | null;
  topics: string[];
  source: string;
  sourceUrl: string;
  /**
   * Phase C structured knowledge for this problem (what the problem
   * exercises — NOT learner ability; mastery/weakness never appears here).
   * Absent when the problem is unclassified; the coach then works from the
   * statement alone, exactly as before Phase C.
   */
  classification?: ProblemClassification | null;
}

export interface AIContextAttemptSummary {
  attemptId: string;
  startedAt: string;
  completedAt: string | null;
  finalState: string;
}

export interface AIContextAttempt {
  attemptId: string;
  startedAt: string;
  currentState: string;
  stateHistory: Attempt['stateHistory'];
  language?: string;
}

export interface AIContextCheckpoint {
  timestamp: string;
  reason: string;
  uri: string;
  language: string;
  snapshotChars: number;
  /** True for the observed starting state — NOT learner-authored evidence. */
  baseline: boolean;
  /** Full text only for the newest few; older ones carry metadata. */
  snapshot: string | null;
}

export interface CodeBaseline {
  snapshot: string;
  uri: string;
  timestamp: string;
}

export interface CodeEvolutionDiff {
  /** Human-readable label, e.g. `save@10:01 -> run@10:07`. */
  label: string;
  /** Git-style text derived from exact states (display only, never canonical). */
  diff: string;
  truncated: boolean;
}

export interface AIContextCode {
  uri: string | null;
  language: string | null;
  /** Best-known current source (latest checkpoint or null). */
  currentText: string | null;
  /**
   * Exact source replayed deterministically from the attempt baseline plus
   * the attempt's own edits; null when no anchor or a continuity gap exists.
   * The model must never reconstruct source itself.
   */
  reconstructedSource: string | null;
  reconstructionOk: boolean;
  /** Observed starting state (provenance, not learner-authored evidence). */
  baseline: CodeBaseline | null;
  /** Derived human-readable diffs between consecutive checkpoints. */
  evolutionDiffs: CodeEvolutionDiff[];
  recentEdits: CodeEditRecord[];
  checkpoints: AIContextCheckpoint[];
}

export interface AIContextExecution {
  timestamp: string;
  kind: 'terminal' | 'run' | 'test' | 'diagnostics';
  summary: string;
  exitCode?: number | null;
  status?: string;
}

/**
 * Learner-model placeholder for V1. Stays empty until a later phase builds
 * real evidence aggregation. Never invent mastery: exposure ≠ proficiency,
 * so nothing here may claim the learner "knows" anything.
 */
export interface LearnerContext {
  notes: string[];
}

export interface AIContext {
  version: number;
  builtAt: string;
  problem: AIContextProblem;
  attempt: AIContextAttempt;
  previousAttempts: AIContextAttemptSummary[];
  code: AIContextCode;
  executions: AIContextExecution[];
  conversation: AIConversationMessage[];
  learnerContext: LearnerContext;
  /**
   * Phase E deterministic coaching briefing (learner-aware slice +
   * previous-intervention situation). Optional: absent when the coach
   * layer has nothing to add, keeping contexts byte-identical to
   * pre-Phase-E. Never raw history — see coachContext caps.
   */
  coachBriefing?: CoachContext | null;
}

export interface BuildAIContextArgs {
  problem: Problem;
  attempt: Attempt;
  /** Earlier attempts on the same problem (excludes the current one). */
  previousAttempts: Attempt[];
  /** Newest-first or oldest-first accepted; recent tail is used. */
  edits: CodeEditRecord[];
  checkpoints: CodeCheckpoint[];
  /** Session events for execution/test/diagnostic evidence. */
  sessionEvents: ActivityEvent[];
  /** Prior coach/learner exchanges for this attempt (oldest-first). */
  conversation?: AIConversationMessage[];
  learnerContext?: LearnerContext;
  /** Phase C classification for the problem (absent = unclassified). */
  classification?: ProblemClassification | null;
  /** Phase E coaching briefing (absent = coach from base context alone). */
  coachBriefing?: CoachContext | null;
  now?: string;
}

function payloadRecord(event: ActivityEvent): Record<string, unknown> {
  const p: unknown = event.payload;
  return typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value: unknown = record[key];
  return typeof value === 'string' ? value : null;
}

/** Extract local execution/test/diagnostic evidence from raw session events. */
export function extractExecutionEvidence(events: ActivityEvent[]): AIContextExecution[] {
  const out: AIContextExecution[] = [];
  for (const event of events) {
    const payload = payloadRecord(event);
    switch (event.eventType) {
      case 'terminal.commandCompleted': {
        const command = stringField(payload, 'commandLine') ?? '(unknown command)';
        const exit = payload.exitCode;
        out.push({
          timestamp: event.timestamp,
          kind: 'terminal',
          summary: `terminal: ${command}`,
          exitCode: typeof exit === 'number' ? exit : null,
        });
        break;
      }
      case 'run.completed': {
        const label = stringField(payload, 'label') ?? stringField(payload, 'taskName') ?? '(task)';
        const exit = payload.exitCode;
        out.push({
          timestamp: event.timestamp,
          kind: 'run',
          summary: `run: ${label}`,
          exitCode: typeof exit === 'number' ? exit : null,
        });
        break;
      }
      case 'test.ended': {
        const label = stringField(payload, 'testLabel') ?? '(test)';
        const status = stringField(payload, 'status') ?? 'unknown';
        out.push({
          timestamp: event.timestamp,
          kind: 'test',
          summary: `test ${label}: ${status}`,
          status,
        });
        break;
      }
      case 'diagnostics.changed': {
        const diags: unknown = payload.diagnostics;
        if (Array.isArray(diags)) {
          let errors = 0;
          let warnings = 0;
          for (const d of diags) {
            if (typeof d === 'object' && d !== null) {
              const severity: unknown = (d as Record<string, unknown>).severity;
              if (severity === 'error') {
                errors++;
              } else if (severity === 'warning') {
                warnings++;
              }
            }
          }
          if (errors > 0 || warnings > 0) {
            const uri = stringField(payload, 'uri') ?? '(unknown file)';
            out.push({
              timestamp: event.timestamp,
              kind: 'diagnostics',
              summary: `diagnostics ${uri}: ${errors} error(s), ${warnings} warning(s)`,
            });
          }
        }
        break;
      }
      default:
        break; // Other events are not execution evidence.
    }
  }
  return out.slice(-MAX_EXECUTIONS);
}

export function buildAIContext(args: BuildAIContextArgs): AIContext {
  const { problem, attempt } = args;
  const sortedCheckpoints = [...args.checkpoints].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const newestFirst = [...sortedCheckpoints].reverse();
  const checkpoints: AIContextCheckpoint[] = newestFirst.map((c, index) => ({
    timestamp: c.timestamp,
    reason: c.reason,
    uri: c.uri,
    language: c.language,
    snapshotChars: c.snapshot.length,
    baseline: c.baseline,
    snapshot: index < MAX_CHECKPOINT_SNAPSHOTS ? c.snapshot : null,
  }));
  const newest = newestFirst[0] ?? null;
  // Scope code evolution to THIS attempt: earlier attempts' edits (e.g. a
  // reused file's prior solution) must never read as this learner's work.
  const ownEdits = selectAttemptEdits(args.edits, attempt.attemptId);
  const recentEdits = ownEdits.slice(-MAX_RECENT_EDITS);
  const baseline = attemptBaseline(args.checkpoints, attempt.attemptId);
  // Reconstruct exact current source from baseline + own edits for the
  // newest document only; anything else is an explicit failure, never a guess.
  let reconstructedSource: string | null = null;
  let reconstructionOk = false;
  if (baseline && newest && baseline.uri === newest.uri) {
    const uriEdits = recentEdits
      .filter((e) => e.uri === newest.uri)
      .sort((a, b) => a.versionAfter - b.versionAfter || a.timestamp.localeCompare(b.timestamp));
    if (uriEdits.length === 0) {
      reconstructionOk = true;
      reconstructedSource = baseline.snapshot;
    } else if (
      baseline.documentVersion === null ||
      uriEdits[0].versionBefore === baseline.documentVersion
    ) {
      // The baseline anchors the chain only when versions join up;
      // otherwise the starting state is unknown — say so explicitly.
      const replay = tryReconstructSource(baseline.snapshot, uriEdits);
      reconstructionOk = replay.ok;
      reconstructedSource = replay.text;
    }
  }
  // Derived human-readable diffs between consecutive checkpoints (newest
  // pairs only). Display aid for comprehension; structured edits stay canonical.
  const evolutionDiffs: CodeEvolutionDiff[] = [];
  const pairs = sortedCheckpoints.slice(-(MAX_EVOLUTION_PAIRS + 1));
  for (let i = 1; i < pairs.length; i++) {
    const from = pairs[i - 1];
    const to = pairs[i];
    if (from.uri !== to.uri) {
      continue;
    }
    const rendered = formatTextDiff(computeLineDiff(from.snapshot, to.snapshot));
    const truncated = rendered.length > MAX_EVOLUTION_DIFF_CHARS;
    evolutionDiffs.push({
      label: `${from.reason}@${from.timestamp} -> ${to.reason}@${to.timestamp}`,
      diff: truncated ? rendered.slice(0, MAX_EVOLUTION_DIFF_CHARS) + '\n…[truncated]' : rendered,
      truncated,
    });
  }
  const conversation = (args.conversation ?? []).slice(-MAX_CONVERSATION_MESSAGES);
  return {
    version: AI_CONTEXT_VERSION,
    builtAt: args.now ?? new Date().toISOString(),
    problem: {
      problemId: problem.problemId,
      provider: problem.provider,
      providerId: problem.providerId,
      canonicalUrl: problem.canonicalUrl,
      title: problem.title,
      statement: problem.statement,
      constraints: problem.constraints,
      examples: problem.examples,
      difficulty: problem.difficulty,
      topics: problem.topics,
      source: problem.provenance.source,
      sourceUrl: problem.provenance.sourceUrl,
      // Conditional spread keeps pre-Phase-C contexts byte-identical when no
      // classification is supplied (existing prompt snapshots unaffected).
      ...(args.classification ? { classification: args.classification } : {}),
    },
    attempt: {
      attemptId: attempt.attemptId,
      startedAt: attempt.startedAt,
      currentState: attempt.currentState,
      stateHistory: attempt.stateHistory,
      ...(attempt.language !== undefined ? { language: attempt.language } : {}),
    },
    previousAttempts: args.previousAttempts
      .filter((a) => a.attemptId !== attempt.attemptId)
      .map((a) => ({
        attemptId: a.attemptId,
        startedAt: a.startedAt,
        completedAt: a.completedAt,
        finalState: a.currentState,
      })),
    code: {
      uri: newest ? newest.uri : null,
      language: newest ? newest.language : null,
      currentText: newest ? newest.snapshot : null,
      reconstructedSource,
      reconstructionOk,
      baseline: baseline
        ? { snapshot: baseline.snapshot, uri: baseline.uri, timestamp: baseline.timestamp }
        : null,
      evolutionDiffs,
      recentEdits,
      checkpoints,
    },
    executions: extractExecutionEvidence(args.sessionEvents),
    conversation,
    learnerContext: args.learnerContext ?? { notes: [] },
    // Conditional spread keeps pre-Phase-E contexts byte-identical when no
    // briefing is supplied (existing prompt snapshots unaffected).
    ...(args.coachBriefing ? { coachBriefing: args.coachBriefing } : {}),
  };
}
