import type { DiagnosticConfidence } from '../ai/aiTypes';
import type { AttemptState } from '../attempts/attempt';
import type { DifficultyType } from '../coach/coachTypes';
import type { KnowledgeGraph } from '../knowledge/ontologyStore';
import type { LearningGoal } from '../goals/goalTypes';
import type { EvidenceType } from '../learner/learnerTypes';
import type { LearnerEvidence } from '../learner/learnerEvidence';
import type { LearnerProfile } from '../learner/learnerModel';
import type { ReflectionCategory } from '../reflection/reflectionTypes';

/**
 * Phase I Stage 0 — transient diagnostic reasoning (pure, non-persistent).
 *
 * A hypothesis here is a temporary explanation used to decide what evidence
 * should be collected next — never "the learner has this weakness". Every
 * call reconstructs hypotheses from the authoritative inputs it is given;
 * nothing is stored, accumulated, versioned, or transitioned. Same inputs
 * always yield the same output (deterministic IDs included), so there is
 * no history to go stale and no parallel learner-belief system to drift.
 *
 * Epistemic rules (load-bearing):
 * - Telemetry tallies are text-pattern observations, documented as
 *   approximations — never proof of intent, understanding, or traits.
 * - Confidence is capped at `medium`; single events stay `low` or absent.
 * - Kind names carry their own humility (`-uncertainty`, `-possibility`).
 * - Banned outputs: weakness verdicts, trait labels ("rote learner"),
 *   motivation claims, mastery claims. There is no vocabulary for them here.
 *
 * Boundary notes (frozen phases stay authoritative):
 * - D is read (evidence/profile), never written; no evidence created.
 * - C is referenced by canonical ID only (`graph.hasEntity`); unknown IDs
 *   are skipped honestly, never invented around.
 * - F1 goals/needs are consumed read-only; no lifecycle calls.
 * - F2 plans are never created/selected/sequenced here (no F2 imports).
 * - E is never invoked here; `selectDiscriminatingNeed` only emits a
 *   `coachSignal` shaped for E's EXISTING decision input (see below).
 * - H is never imported; callers build the plain-data inputs below from
 *   existing H queries where needed.
 */

export type DiagnosticHypothesisKind =
  | 'boundary-invariant-uncertainty'
  | 'implementation-friction'
  | 'debugging-process-difficulty'
  | 'language-fluency-friction'
  | 'template-perturbation-possibility';

export const DIAGNOSTIC_HYPOTHESIS_KINDS: readonly DiagnosticHypothesisKind[] = [
  'boundary-invariant-uncertainty',
  'implementation-friction',
  'debugging-process-difficulty',
  'language-fluency-friction',
  'template-perturbation-possibility',
];

export function isKnownDiagnosticHypothesisKind(value: unknown): value is DiagnosticHypothesisKind {
  return typeof value === 'string' && (DIAGNOSTIC_HYPOTHESIS_KINDS as readonly string[]).includes(value);
}

export interface DiagnosticHypothesis {
  /** Deterministic id (`hyp_<kind>_<goalId|no-goal>`); same inputs → same id. */
  id: string;
  kind: DiagnosticHypothesisKind;
  /** Capped at `medium` by construction; single events stay `low`. */
  confidence: DiagnosticConfidence;
  /** Real D evidence IDs supporting this possibility (capped, oldest first). */
  basisEvidenceIds: string[];
  /** Observed tallies behind this possibility (bounded prose, counts only). */
  observedSignals: string[];
  /** What cannot currently be established (never empty when rivals exist). */
  unknowns: string[];
  /** Competing explanations preserved alongside this one. */
  rivals: DiagnosticHypothesisKind[];
}

export interface HypothesisSet {
  hypotheses: DiagnosticHypothesis[];
  /** Result-level unknowns (e.g. thin evidence); may be empty when grounded. */
  unknowns: string[];
}

/** One attempt's observed evolution, as plain caller-built data. */
export interface AttemptEvolutionObservation {
  attemptId: string;
  problemId: string;
  /** Learner-reported outcome (context, never ground truth). */
  finalState: AttemptState;
  /** Attempt-scoped, same-file inserted texts (exact telemetry, caller-filtered). */
  edits: Array<{ insertedText: string }>;
  syntaxErrorCount: number;
  executionFailureCount: number;
  convergedToSuccess: boolean;
  /** Whether the learner explained their reasoning (conversation/reflection). */
  hasExplanatoryReply: boolean;
}

export interface DeriveHypothesesInput {
  /** F1 goal context when present (read-only; null = goal-free reasoning). */
  goal: LearningGoal | null;
  profile: LearnerProfile | null;
  /** Caller-scoped evidence (goal-local when a goal is present). */
  evidence: LearnerEvidence[];
  evolution: AttemptEvolutionObservation[];
  /** Learner-reported G categories only (voice, never fact). */
  reflectionCategories: ReflectionCategory[];
  /** Canonical-entity validation only. */
  graph: KnowledgeGraph;
}

export interface EstablishedNeed {
  needId: string;
  summary: string;
}

export interface DiscriminatingContext {
  goal: LearningGoal | null;
  learnerRequested: boolean;
  learnerStatement?: string;
  /** F1-derived need, when the caller already established one (no invention here). */
  establishedNeed?: EstablishedNeed | null;
}

/** Coach-routable signal shaped for E's EXISTING DecisionInput fields. */
export interface DiagnosticCoachSignal {
  difficultyType: DifficultyType;
  /**
   * `low` exactly when asking-because-uncertain (the decision situation),
   * so E's existing hard rule (low + unknowns → question) applies without
   * any E change. This is confidence in what to do, never in the learner.
   */
  diagnosticConfidence: DiagnosticConfidence;
  hasUnknowns: true;
}

export type DiscriminatingRoute =
  | { route: 'ask-coach'; coachSignal: DiagnosticCoachSignal; hypotheses: DiagnosticHypothesis[]; rationale: string }
  | { route: 'use-established-need'; needId: string; hypotheses: DiagnosticHypothesis[]; rationale: string }
  | { route: 'honor-learner-request'; statement: string; hypotheses: DiagnosticHypothesis[]; rationale: string }
  | { route: 'no-diagnostic-action'; hypotheses: DiagnosticHypothesis[]; rationale: string };

/** Corroboration thresholds (counts, never scores; single events never qualify). */
export const MIN_BOUNDARY_MUTATIONS = 2;
export const MIN_PERTURBATION_EDITS = 3;
export const MIN_EDITS_FOR_FRICTION = 4;
export const MIN_EXECUTION_FAILURES = 2;
export const MIN_SYNTAX_ERRORS = 2;
export const MAX_HYPOTHESIS_EVIDENCE_IDS = 12;
export const MAX_HYPOTHESIS_TEXT_CHARS = 200;
export const MAX_DIAGNOSTIC_RATIONALE_CHARS = 280;

function clip(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Counts edits containing boundary-token changes. Approximation by design:
 * `->` and `=>` are stripped first; remaining comparison operators and
 * ±1 adjustments are tallied per edit (not per match). Proves that such
 * text appeared — never why it was written.
 */
function isBoundaryLikeEdit(insertedText: string): boolean {
  const stripped = insertedText.replace(/->/g, '').replace(/=>/g, '');
  return /(<=|>=|==|!=|<|>)/.test(stripped) || /[+-]\s*1\b/.test(stripped);
}

/** Counts edits touching branch keywords. Coarse by design (see above). */
function isBranchRelatedEdit(insertedText: string): boolean {
  return /\b(if|else|elif)\b/.test(insertedText);
}

function isPerturbationLikeEdit(insertedText: string): boolean {
  return isBoundaryLikeEdit(insertedText) || isBranchRelatedEdit(insertedText);
}

const CONCEPTUAL_SIGNAL_TYPES: readonly EvidenceType[] = ['CONCEPTUAL_CONFUSION', 'CONCEPTUAL_SUCCESS'];
const IMPLEMENTATION_SIGNAL_TYPES: readonly EvidenceType[] = [
  'IMPLEMENTATION_FAILURE',
  'IMPLEMENTATION_SUCCESS',
  'DEBUGGING_FAILURE',
  'DEBUGGING_SUCCESS',
];
const DEBUGGING_SIGNAL_TYPES: readonly EvidenceType[] = ['DEBUGGING_FAILURE', 'DEBUGGING_SUCCESS'];

interface EvidenceSupport {
  /** Real D evidence IDs of the mapped types in scope (capped, oldest first). */
  ids: string[];
  /**
   * True when at least one supporting record exists AND every supporting
   * record's entities are tracked in the provided D profile. A stale or
   * missing profile therefore preserves uncertainty instead of inflating
   * confidence: unfolded evidence alone never corroborates toward medium.
   */
  tracked: boolean;
}

function gatherSupport(
  evidence: LearnerEvidence[],
  entityIds: string[] | null,
  types: readonly EvidenceType[],
  trackedEntityIds: Set<string> | null,
): EvidenceSupport {
  const ids: string[] = [];
  let allTracked = true;
  for (const record of evidence) {
    if (!types.includes(record.evidenceType)) {
      continue;
    }
    if (entityIds !== null && !record.entityIds.some((id) => entityIds.includes(id))) {
      continue;
    }
    if (ids.length < MAX_HYPOTHESIS_EVIDENCE_IDS) {
      ids.push(record.evidenceId);
    }
    if (trackedEntityIds === null || !record.entityIds.every((id) => trackedEntityIds.has(id))) {
      allTracked = false;
    }
  }
  return { ids, tracked: ids.length > 0 && allTracked };
}

function hypothesisId(kind: DiagnosticHypothesisKind, goal: LearningGoal | null): string {
  return `hyp_${kind}_${goal ? goal.goalId : 'no-goal'}`;
}

function withRivals(
  kind: DiagnosticHypothesisKind,
  kinds: DiagnosticHypothesisKind[],
): DiagnosticHypothesisKind[] {
  return kinds.filter((other) => other !== kind).sort();
}

/**
 * Reconstructs working diagnostic hypotheses from authoritative inputs.
 * Pure: no stores, no writes, no AI, no accumulation. Returns competing
 * possibilities with rivals preserved — never a single verdict.
 */
export function deriveHypotheses(input: DeriveHypothesesInput): HypothesisSet {
  const knownEntityIds =
    input.goal === null ? null : input.goal.entityIds.filter((id) => input.graph.hasEntity(id));
  if (input.goal !== null && knownEntityIds !== null && knownEntityIds.length === 0) {
    return {
      hypotheses: [],
      unknowns: ['The goal references no known knowledge entities, so nothing can be discriminated yet.'],
    };
  }
  const scopedEvidence =
    knownEntityIds === null
      ? [...input.evidence]
      : input.evidence.filter((record) => record.entityIds.some((id) => knownEntityIds.includes(id)));

  let boundaryMutationEdits = 0;
  let perturbationEdits = 0;
  let totalEdits = 0;
  let syntaxErrors = 0;
  let executionFailures = 0;
  let convergedAfterPerturbation = false;
  let anyExplanatoryReply = false;
  const signallingAttemptIds = new Set<string>();
  for (const observation of input.evolution) {
    let observedHere = false;
    for (const edit of observation.edits) {
      totalEdits += 1;
      const perturbationLike = isPerturbationLikeEdit(edit.insertedText);
      if (isBoundaryLikeEdit(edit.insertedText)) {
        boundaryMutationEdits += 1;
      }
      if (perturbationLike) {
        perturbationEdits += 1;
        observedHere = true;
      }
    }
    if (observedHere) {
      signallingAttemptIds.add(observation.attemptId);
    }
    syntaxErrors += Math.max(0, observation.syntaxErrorCount);
    executionFailures += Math.max(0, observation.executionFailureCount);
    if (observation.convergedToSuccess && observation.edits.some((edit) => isPerturbationLikeEdit(edit.insertedText))) {
      convergedAfterPerturbation = true;
    }
    if (observation.hasExplanatoryReply) {
      anyExplanatoryReply = true;
    }
  }
  const spansMultipleAttempts = signallingAttemptIds.size >= 2;
  const trackedEntityIds =
    input.profile === null ? null : new Set(input.profile.knowledgeStates.map((state) => state.entityId));

  const conceptualSupport = gatherSupport(scopedEvidence, knownEntityIds, CONCEPTUAL_SIGNAL_TYPES, trackedEntityIds);
  const implementationSupport = gatherSupport(
    scopedEvidence,
    knownEntityIds,
    IMPLEMENTATION_SIGNAL_TYPES,
    trackedEntityIds,
  );
  const debuggingSupport = gatherSupport(scopedEvidence, knownEntityIds, DEBUGGING_SIGNAL_TYPES, trackedEntityIds);
  const categories = new Set<string>(input.reflectionCategories);

  const derived: DiagnosticHypothesis[] = [];

  if (boundaryMutationEdits >= MIN_BOUNDARY_MUTATIONS) {
    const corroborated = spansMultipleAttempts || conceptualSupport.tracked;
    derived.push({
      id: hypothesisId('boundary-invariant-uncertainty', input.goal),
      kind: 'boundary-invariant-uncertainty',
      confidence: corroborated ? 'medium' : 'low',
      basisEvidenceIds: [...conceptualSupport.ids],
      observedSignals: [
        clip(`${boundaryMutationEdits} boundary-token edits across ${signallingAttemptIds.size} attempt(s)`, MAX_HYPOTHESIS_TEXT_CHARS),
      ],
      unknowns: [
        'Whether the learner can state the interval invariant maintained by this loop.',
      ],
      rivals: [],
    });
  }

  const implementationTally = totalEdits >= MIN_EDITS_FOR_FRICTION && executionFailures >= 1;
  const implementationReflected = categories.has('knew-idea-struggled-implement');
  if (implementationTally || implementationSupport.ids.length > 0 || implementationReflected) {
    const corroborated =
      (implementationTally && implementationSupport.tracked) ||
      spansMultipleAttempts ||
      (implementationReflected && (implementationTally || implementationSupport.tracked));
    derived.push({
      id: hypothesisId('implementation-friction', input.goal),
      kind: 'implementation-friction',
      confidence: corroborated ? 'medium' : 'low',
      basisEvidenceIds: [...implementationSupport.ids],
      observedSignals: [
        clip(
          `${totalEdits} edits with ${executionFailures} execution failure(s)` +
            (implementationReflected ? '; learner reported knowing the idea but struggling to implement it' : ''),
          MAX_HYPOTHESIS_TEXT_CHARS,
        ),
      ],
      unknowns: ['Whether the approach was decided before coding began.'],
      rivals: [],
    });
  }

  if (perturbationEdits >= MIN_PERTURBATION_EDITS && convergedAfterPerturbation) {
    derived.push({
      id: hypothesisId('template-perturbation-possibility', input.goal),
      kind: 'template-perturbation-possibility',
      confidence: spansMultipleAttempts && !anyExplanatoryReply ? 'medium' : 'low',
      basisEvidenceIds: [],
      observedSignals: [
        clip(
          `${perturbationEdits} perturbation-like edits converging to success` +
            (anyExplanatoryReply ? ' with a learner explanation on record' : ' without a learner explanation on record'),
          MAX_HYPOTHESIS_TEXT_CHARS,
        ),
      ],
      unknowns: ['Whether the final solution was reached by reasoning or by trying alternatives.'],
      rivals: [],
    });
  }

  const debuggingTally =
    executionFailures >= MIN_EXECUTION_FAILURES && !convergedAfterPerturbation && totalEdits >= MIN_EDITS_FOR_FRICTION;
  if (debuggingTally || debuggingSupport.ids.length > 0 || categories.has('debugging-mistake')) {
    const corroborated =
      (debuggingTally && debuggingSupport.tracked) ||
      spansMultipleAttempts ||
      (categories.has('debugging-mistake') && (debuggingTally || debuggingSupport.tracked));
    derived.push({
      id: hypothesisId('debugging-process-difficulty', input.goal),
      kind: 'debugging-process-difficulty',
      confidence: corroborated ? 'medium' : 'low',
      basisEvidenceIds: [...debuggingSupport.ids],
      observedSignals: [
        clip(`${executionFailures} execution failure(s) across ${totalEdits} edits without convergence`, MAX_HYPOTHESIS_TEXT_CHARS),
      ],
      unknowns: ['Which failing behavior the learner has already ruled out.'],
      rivals: [],
    });
  }

  if (
    syntaxErrors >= MIN_SYNTAX_ERRORS &&
    boundaryMutationEdits < MIN_BOUNDARY_MUTATIONS &&
    conceptualSupport.ids.length === 0
  ) {
    derived.push({
      id: hypothesisId('language-fluency-friction', input.goal),
      kind: 'language-fluency-friction',
      confidence: spansMultipleAttempts ? 'medium' : 'low',
      basisEvidenceIds: [],
      observedSignals: [clip(`${syntaxErrors} syntax errors without boundary or conceptual signals`, MAX_HYPOTHESIS_TEXT_CHARS)],
      unknowns: ['Whether the errors reflect language unfamiliarity rather than the algorithm.'],
      rivals: [],
    });
  }

  if (derived.length === 0) {
    return {
      hypotheses: [],
      unknowns: ['No relevant telemetry or evidence in scope; nothing can be concluded yet.'],
    };
  }
  const kinds = derived.map((hypothesis) => hypothesis.kind);
  const resultUnknowns: string[] = [];
  for (const hypothesis of derived) {
    hypothesis.rivals = withRivals(hypothesis.kind, kinds);
    for (const unknown of hypothesis.unknowns) {
      if (!resultUnknowns.includes(unknown)) {
        resultUnknowns.push(unknown);
      }
    }
  }
  derived.sort((a, b) => a.kind.localeCompare(b.kind));
  return { hypotheses: derived, unknowns: resultUnknowns };
}

function difficultyForKind(kind: DiagnosticHypothesisKind): DifficultyType {
  switch (kind) {
    case 'boundary-invariant-uncertainty':
      return 'conceptual';
    case 'implementation-friction':
      return 'implementation';
    case 'debugging-process-difficulty':
      return 'debugging';
    case 'language-fluency-friction':
      return 'tooling';
    case 'template-perturbation-possibility':
      return 'unknown';
  }
}

/**
 * Selects what uncertainty (if any) matters enough to resolve before
 * choosing an intervention. Returns a route — never a weakness verdict,
 * never an activity selection, never a plan. `ask-coach` carries only the
 * three fields E's existing hard rule needs; E itself is never invoked here.
 */
export function selectDiscriminatingNeed(
  hypotheses: HypothesisSet,
  context: DiscriminatingContext,
): DiscriminatingRoute {
  if (context.learnerRequested) {
    const statement =
      typeof context.learnerStatement === 'string' && context.learnerStatement.trim().length > 0
        ? context.learnerStatement.trim()
        : 'Learner-requested practice.';
    return {
      route: 'honor-learner-request',
      statement: clip(statement, MAX_DIAGNOSTIC_RATIONALE_CHARS),
      hypotheses: [...hypotheses.hypotheses],
      rationale: clip(
        'Practice was explicitly requested; no weakness hypothesis is manufactured for it.',
        MAX_DIAGNOSTIC_RATIONALE_CHARS,
      ),
    };
  }
  if (context.establishedNeed !== null && context.establishedNeed !== undefined) {
    return {
      route: 'use-established-need',
      needId: context.establishedNeed.needId,
      hypotheses: [...hypotheses.hypotheses],
      rationale: clip(
        `An established learning need (${context.establishedNeed.needId}) already grounds the intervention; no new diagnostic hypothesis is required.`,
        MAX_DIAGNOSTIC_RATIONALE_CHARS,
      ),
    };
  }
  const competing = hypotheses.hypotheses.filter((hypothesis) => hypothesis.unknowns.length > 0);
  if (competing.length >= 2) {
    const kinds = competing.map((hypothesis) => hypothesis.kind).sort();
    const top = competing[0];
    const difficultyType = top ? difficultyForKind(top.kind) : 'unknown';
    return {
      route: 'ask-coach',
      coachSignal: { difficultyType, diagnosticConfidence: 'low', hasUnknowns: true },
      hypotheses: [...hypotheses.hypotheses],
      rationale: clip(
        `${competing.length} competing explanations (${kinds.join(', ')}) with open unknowns; asking first rather than assuming a weakness.`,
        MAX_DIAGNOSTIC_RATIONALE_CHARS,
      ),
    };
  }
  return {
    route: 'no-diagnostic-action',
    hypotheses: [...hypotheses.hypotheses],
    rationale: clip(
      'Evidence is too thin to discriminate explanations; normal planning proceeds without a diagnostic detour.',
      MAX_DIAGNOSTIC_RATIONALE_CHARS,
    ),
  };
}
