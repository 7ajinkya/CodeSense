import { AGGREGATOR_VERSION } from '../learner/learnerTypes';
import { getDefaultKnowledgeGraph } from '../knowledge/ontologyStore';
import { LocalProblemStore } from '../problems/problemStore';
import { LocalAttemptStore } from '../attempts/attemptStore';
import { LocalClassificationStore } from '../knowledge/classificationStore';
import { LocalLearnerEvidenceStore } from '../learner/learnerEvidenceStore';
import { LocalLearnerModelStore } from '../learner/learnerModelStore';
import { LocalAiStore } from '../ai/aiStore';
import { LocalGoalStore } from '../goals/goalStore';
import { LocalActivityPlanStore } from '../practice/activityStore';
import { LocalProgressStore } from '../progress/progressStore';
import { LocalReflectionStore } from '../reflection/reflectionStore';
import { loadSessionsFromDisk } from '../persistence/localStore';
import type { Problem } from '../problems/problem';
import type { Attempt } from '../attempts/attempt';
import type { ProblemClassification } from '../knowledge/classification';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearnerProfile } from '../learner/learnerModel';
import type { AIEvaluation } from '../ai/aiTypes';
import type { LearningGoal } from '../goals/goalTypes';
import type { ActivityPlan } from '../practice/activityTypes';
import type { ActivityProgress } from '../progress/progressTypes';
import type { LearnerReflection } from '../reflection/reflectionTypes';
import type {
  AnalyticsSnapshot,
  ConversationCount,
  SessionSummary,
} from './analyticsTypes';

/**
 * Phase H V1 — AnalyticsSource (read-only loader seam).
 *
 * V1 implements one source (LocalAnalyticsSource) that fresh-reads every
 * store via the existing Local*Store classes. Fail-open per leg: one
 * failing store yields []/null for that leg plus a loadWarning — never a
 * throw, never a partial write.
 *
 * Future selective sources implement the same interface and return the same
 * AnalyticsSnapshot shape with completeness.complete=false. Query/view
 * contracts take only AnalyticsSnapshot, so they do not change.
 */

export interface AnalyticsSource {
  listProblems(): Promise<Problem[]>;
  listAttempts(): Promise<Attempt[]>;
  listClassifications(): Promise<ProblemClassification[]>;
  listEvidence(): Promise<LearnerEvidence[]>;
  loadProfile(): Promise<LearnerProfile | null>;
  listEvaluations(): Promise<AIEvaluation[]>;
  listConversationCounts(): Promise<ConversationCount[]>;
  listGoals(): Promise<LearningGoal[]>;
  listPlans(): Promise<ActivityPlan[]>;
  listProgress(): Promise<ActivityProgress[]>;
  listReflections(): Promise<LearnerReflection[]>;
  listSessionSummaries(): Promise<SessionSummary[]>;
}

export class LocalAnalyticsSource implements AnalyticsSource {
  constructor(private readonly workspacePath?: string) {}

  async listProblems(): Promise<Problem[]> {
    return new LocalProblemStore(this.workspacePath).listProblems();
  }

  async listAttempts(): Promise<Attempt[]> {
    // AttemptStore is keyed per problem/session; fan out via problems first,
    // falling back to [] when no problems exist. Attempts for unknown
    // problems (hand-edited stores) are still reachable via session fan-out
    // below when sessions exist — best-effort, never a throw.
    const problems = await this.listProblems().catch(() => []);
    const store = new LocalAttemptStore(this.workspacePath);
    const byId = new Map<string, Attempt>();
    for (const problem of problems) {
      const mine = await store.listAttemptsForProblem(problem.problemId).catch(() => []);
      for (const attempt of mine) {
        byId.set(attempt.attemptId, attempt);
      }
    }
    // Session fan-out catches attempts whose problem row is missing.
    const sessions = await this.listSessionSummaries().catch(() => []);
    void sessions;
    return [...byId.values()].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptId.localeCompare(b.attemptId),
    );
  }

  async listClassifications(): Promise<ProblemClassification[]> {
    return new LocalClassificationStore(this.workspacePath).listClassifications();
  }

  async listEvidence(): Promise<LearnerEvidence[]> {
    return new LocalLearnerEvidenceStore(this.workspacePath).listEvidence();
  }

  async loadProfile(): Promise<LearnerProfile | null> {
    return new LocalLearnerModelStore(this.workspacePath).loadProfile();
  }

  async listEvaluations(): Promise<AIEvaluation[]> {
    const attempts = await this.listAttempts().catch(() => []);
    const store = new LocalAiStore(this.workspacePath);
    const out: AIEvaluation[] = [];
    const seen = new Set<string>();
    for (const attempt of attempts) {
      const mine = await store.listEvaluationsForAttempt(attempt.attemptId).catch(() => []);
      for (const evaluation of mine) {
        if (!seen.has(evaluation.evaluationId)) {
          seen.add(evaluation.evaluationId);
          out.push(evaluation);
        }
      }
    }
    return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async listConversationCounts(): Promise<ConversationCount[]> {
    const attempts = await this.listAttempts().catch(() => []);
    const store = new LocalAiStore(this.workspacePath);
    const out: ConversationCount[] = [];
    for (const attempt of attempts) {
      const messages = await store.listConversation(attempt.attemptId).catch(() => []);
      let coachMessages = 0;
      let learnerMessages = 0;
      for (const message of messages) {
        if (message.role === 'coach') {
          coachMessages += 1;
        } else {
          learnerMessages += 1;
        }
      }
      if (coachMessages > 0 || learnerMessages > 0) {
        out.push({ attemptId: attempt.attemptId, coachMessages, learnerMessages });
      }
    }
    return out.sort((a, b) => a.attemptId.localeCompare(b.attemptId));
  }

  async listGoals(): Promise<LearningGoal[]> {
    return new LocalGoalStore(this.workspacePath).listGoals();
  }

  async listPlans(): Promise<ActivityPlan[]> {
    return new LocalActivityPlanStore(this.workspacePath).listPlans();
  }

  async listProgress(): Promise<ActivityProgress[]> {
    return new LocalProgressStore(this.workspacePath).listProgress();
  }

  async listReflections(): Promise<LearnerReflection[]> {
    return new LocalReflectionStore(this.workspacePath).listReflections();
  }

  async listSessionSummaries(): Promise<SessionSummary[]> {
    const sessions = loadSessionsFromDisk(this.workspacePath);
    return sessions
      .map((session) => ({
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        eventCount: session.events.length,
        ...(session.primaryLanguage !== undefined ? { primaryLanguage: session.primaryLanguage } : {}),
      }))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}

async function safeLoad<T>(label: string, load: () => Promise<T>, fallback: T, warnings: string[]): Promise<T> {
  try {
    return await load();
  } catch (err) {
    warnings.push(`${label} unavailable (${String(err)})`);
    return fallback;
  }
}

/**
 * Eager V1 load: fresh-read every leg via the source. Appropriate at current
 * CodeSense scale (evidence cap 5000, classifications 10/problem, human-scale
 * attempts/goals/plans; heavy payloads — checkpoint snapshots, conversation
 * text, event payloads — excluded by summary design).
 */
export async function loadAnalyticsSnapshot(
  source: AnalyticsSource,
  opts: { now?: string; scope?: string } = {},
): Promise<AnalyticsSnapshot> {
  const warnings: string[] = [];
  const now = opts.now ?? new Date().toISOString();
  const graph = getDefaultKnowledgeGraph();
  const problems = await safeLoad('problems', () => source.listProblems(), [], warnings);
  const attempts = await safeLoad('attempts', () => source.listAttempts(), [], warnings);
  const classifications = await safeLoad('classifications', () => source.listClassifications(), [], warnings);
  const evidence = await safeLoad('evidence', () => source.listEvidence(), [], warnings);
  const profile = await safeLoad('learner-model', () => source.loadProfile(), null, warnings);
  const evaluations = await safeLoad('evaluations', () => source.listEvaluations(), [], warnings);
  const conversationCounts = await safeLoad(
    'conversation',
    () => source.listConversationCounts(),
    [],
    warnings,
  );
  const goals = await safeLoad('goals', () => source.listGoals(), [], warnings);
  const plans = await safeLoad('plans', () => source.listPlans(), [], warnings);
  const progress = await safeLoad('progress', () => source.listProgress(), [], warnings);
  const reflections = await safeLoad('reflections', () => source.listReflections(), [], warnings);
  const sessions = await safeLoad('sessions', () => source.listSessionSummaries(), [], warnings);
  return {
    problems,
    attempts,
    classifications,
    evidence,
    profile,
    evaluations,
    conversationCounts,
    goals,
    plans,
    progress,
    reflections,
    sessions,
    ontologyVersion: graph.ontologyVersion,
    aggregatorVersion: AGGREGATOR_VERSION,
    loadedAt: now,
    completeness: {
      complete: warnings.length === 0,
      scope: opts.scope ?? 'full history',
      truncatedReasons: [],
      loadWarnings: warnings,
    },
    unresolvedIds: [],
  };
}
