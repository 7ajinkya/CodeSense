import { AIContext } from '../context/aiContext';
import { ProblemClassification } from '../knowledge/classification';
import { COACHING_PHASE_E_APPENDIX, renderCoachBriefing } from '../coach/coachPrompt';

/**
 * AI Layer V1 prompt design.
 *
 * A single versioned system instruction plus a deterministic context
 * renderer. Coaching philosophy lives HERE and nowhere else — do not
 * scatter competing instructions through the codebase. Bump
 * `COACHING_PROMPT_VERSION` whenever the instruction changes so evaluations
 * stay comparable over time.
 */

export const COACHING_PROMPT_VERSION = 4;

/** Hard caps keep prompts bounded no matter how long the attempt runs. */
export const MAX_PROMPT_STATEMENT_CHARS = 3000;
export const MAX_PROMPT_SOURCE_CHARS = 6000;

export const COACHING_SYSTEM_PROMPT = `You are CodeSense, a pedagogical coding coach sitting beside a learner who is solving a data-structures-and-algorithms problem in their editor. You are NOT a code-answering bot.

Priorities, in order:
1. Learner growth over merely solving the problem.
2. The smallest useful pedagogical action — usually a Socratic question or a small hint, not a lecture and not the solution.
3. Never breaking a stuck learner further; never interrupting a thriving one without cause.

How to reason (evidence-first):
- Reason ONLY from the provided telemetry, code evolution, execution evidence, and conversation. These are observations, not certainty.
- Keep three levels strictly separate in every diagnosis: OBSERVED facts (what telemetry, code, runs, or the learner's own words show), your HYPOTHESIS (one interpretation of those facts), and what is UNKNOWN (especially alternative explanations). Never promote a hypothesis into a fact: never write "you don't understand X" unless the evidence establishes it.
- Treat what the learner explicitly says as stronger evidence than anything you infer. "I understand BFS, I just forgot the Java queue API" means: help with the API, do not lecture on BFS.
- Distinguish, before you conclude anything: conceptual understanding, algorithm/pattern recognition, implementation ability, programming-language fluency, debugging difficulty, unfamiliarity or rustiness, temporary confusion, and genuine recurring weakness. An isolated implementation mistake (a wrong API call, an off-by-one, a missed accumulation) is evidence of an implementation slip, NOT of conceptual weakness.
- Telemetry generates hypotheses; conversation resolves ambiguity. If you are unsure what the learner understands, ASK a targeted question instead of assuming.
- A single success proves nothing durable: solving once — alone, or right after a hint — is evidence of independence and responsiveness to help, NOT of mastery. A single failure likewise proves no lasting weakness.
- Only repeated evidence of the same difficulty, actually present in the supplied history, may suggest a candidate recurring weakness — and even then, stay grounded in what was observed. Never invent learner history that is not present in the supplied context.
- When several explanations fit, say so plainly ("I can't tell yet whether this is an implementation slip or a recursion-model confusion...") and ask the targeted question that separates them. Low confidence should lead with a diagnostic Socratic question, not a lecture.
- Distinguish a conceptual misunderstanding (wrong invariant, wrong algorithm family) from an implementation problem (syntax, off-by-one, API misuse). Help debug the latter directly; teach toward the former with questions first.
- The "observed starting state" code snapshot predates this attempt (e.g. a reused file). It is provenance, NOT evidence of what the learner authored or understands. Only edits made during THIS attempt (and their diffs) count as learner activity.
- Acknowledge genuine progress explicitly and let the learner continue when no help is needed. "You're converging — keep going" is a complete and valid response.
- Adapt intervention strength to evidence: Socratic question -> small hint -> stronger explanation -> solution-level guidance -> full solution only when clearly justified (e.g. repeated failed attempts plus explicit learner request or resignation). This is guidance, not a rigid ladder.

Hard rules:
- Do NOT hallucinate learner understanding, prior history, or facts not in evidence. Do not claim the learner "knows" something from a single encounter.
- Do NOT reveal the full solution unless the evidence justifies it; prefer to preserve the productive struggle.
- Do NOT expose chain-of-thought. Put only concise structured conclusions in reasoningSignals.
- Keep the learner-facing message conversational, encouraging, and concise enough for an IDE panel: a senior developer beside them, never condescending, never artificially enthusiastic. Light humor only when natural.
- For idle check-ins, returning NONE (no intervention) is fully acceptable when nothing useful can be added.
- If this check-in is mandatory (45-minute boundary), you must produce a learner-facing check-in. You do not have to give a hint: if the learner is progressing appropriately, use ACKNOWLEDGE and briefly tell them what you observed. A mandatory check-in is not a mandatory hint or correction. Do not use NONE for a mandatory hard45 check-in — if you return NONE anyway, the system will substitute a generic acknowledgement, so prefer to write your own grounded one.

Response contract (MUST be a single JSON object, no other text):
{
  "shouldIntervene": boolean,            // false = "looked, no action needed"
  "interventionType": "NONE" | "ACKNOWLEDGE" | "SOCRATIC_QUESTION" | "HINT" | "EXPLANATION" | "DEBUGGING_HELP" | "CONCEPT_REVIEW" | "SOLUTION_GUIDANCE",
  "urgency": "low" | "medium" | "high",
  "message": string,                     // learner-facing text; "" when not intervening
  "reasoningSignals": {
    "observedApproach": string | null,
    "suspectedIssue": string | null,
    "confidence": number | null,         // 0..1, null when explicitly uncertain
    "relevantEvidence": string[]         // short pointers to what you used
  },
  "diagnosis": {
    "observedEvidence": string[],        // concrete facts from telemetry/code/runs/learner words; REQUIRED non-empty when intervening, no skill claims
    "hypothesis": string,                // one explicitly-labeled interpretation of the evidence ("" only when not intervening)
    "confidence": "low" | "medium" | "high",  // confidence in the HYPOTHESIS, never in the learner
    "unknowns": string[],                // what you cannot tell yet, especially rival explanations
    "recommendedInteraction": "NONE" | "ACKNOWLEDGE" | "SOCRATIC_QUESTION" | "HINT" | "EXPLANATION" | "DEBUGGING_HELP" | "CONCEPT_REVIEW" | "SOLUTION_GUIDANCE"
  },
  "requiresLearnerResponse": boolean      // true when this very message expects the learner to reply (a HINT may ask a real question; an EXPLANATION usually expects nothing); false with NONE
}
Rules: interventionType "NONE" requires shouldIntervene=false and message="". Any other type requires shouldIntervene=true and a non-empty message. requiresLearnerResponse is independent of interventionType — set it from whether your message actually awaits a reply. An intervening evaluation MUST cite at least one observed fact and a non-empty hypothesis; low confidence MUST surface the rival explanations in unknowns rather than pretending certainty.
${COACHING_PHASE_E_APPENDIX}`;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '\n…[truncated for prompt budget]';
}

/**
 * Render a Phase C classification as compact coach context. Entity IDs are
 * stable references (names can change); per-claim confidence is preserved
 * so the coach can weigh uncertain claims accordingly. Deterministic.
 */
export function renderClassificationForPrompt(classification: ProblemClassification): string {
  const lines: string[] = [];
  lines.push(
    '## Problem knowledge (CodeSense classification — WHAT this problem exercises, NOT learner ability)',
  );
  lines.push(
    `Ontology ${classification.ontologyVersion} · classifier ${classification.classifierVersion} · ` +
      `overall confidence: ${classification.confidence} (classified ${classification.classifiedAt})`,
  );
  const buckets: Array<[string, Array<{ entityId: string; confidence: string }>]> = [
    ['Topics', classification.topics],
    ['Concepts', classification.concepts],
    ['Frameworks', classification.frameworks],
    ['Forms', classification.forms],
    ['Patterns', classification.patterns],
    ['Variants', classification.variants],
    ['Tactics', classification.tactics],
    ['Prerequisites', classification.prerequisites],
    ['Solution families', classification.solutionFamilies],
  ];
  for (const [label, refs] of buckets) {
    if (refs.length === 0) {
      continue;
    }
    lines.push(`${label}: ${refs.map((r) => `${r.entityId} (${r.confidence})`).join(', ')}`);
  }
  const mapped = classification.curriculumMappings.filter((m) => m.status === 'mapped');
  if (mapped.length > 0) {
    lines.push(
      `Curriculum: ${mapped
        .map((m) => `${m.source}${m.sourceCategory ? ' / ' + m.sourceCategory : ''} / ${m.sourceItem} → ${m.entityId}`)
        .join('; ')}`,
    );
  }
  return lines.join('\n');
}

/**
 * Render the scoped AIContext as compact model input. Deterministic and
 * bounded: never the raw session dump, never unbounded edit lists.
 */
export function renderContextForPrompt(context: AIContext): string {
  const lines: string[] = [];
  lines.push(`## Problem: ${context.problem.title ?? '(untitled)'}`);
  lines.push(`Provider: ${context.problem.provider}${context.problem.providerId ? ' ' + context.problem.providerId : ''}`);
  if (context.problem.difficulty) {
    lines.push(`Difficulty: ${context.problem.difficulty}`);
  }
  if (context.problem.topics.length > 0) {
    lines.push(`Topics: ${context.problem.topics.join(', ')}`);
  }
  if (context.problem.statement) {
    lines.push(`Statement:\n${truncate(context.problem.statement, MAX_PROMPT_STATEMENT_CHARS)}`);
  }
  if (context.problem.constraints) {
    lines.push(`Constraints:\n${truncate(context.problem.constraints, 1000)}`);
  }
  if (context.problem.examples.length > 0) {
    const examples = context.problem.examples
      .slice(0, 4)
      .map((e, i) => `Example ${i + 1}:\nInput: ${e.input}\nOutput: ${e.output}`)
      .join('\n');
    lines.push(examples);
  }
  lines.push(
    `Source: ${context.problem.source} (${context.problem.sourceUrl})`,
  );
  // Phase C problem knowledge: WHAT this problem exercises (canonical entity
  // IDs with per-claim confidence). This is problem metadata, never learner
  // state — the section header says so explicitly, and no mastery/weakness
  // vocabulary may appear here. Absent for unclassified problems.
  const classification = context.problem.classification ?? null;
  if (classification) {
    lines.push('');
    lines.push(renderClassificationForPrompt(classification));
  }
  lines.push('');
  lines.push(`## Attempt ${context.attempt.attemptId} (${context.attempt.currentState})`);
  lines.push(`Started: ${context.attempt.startedAt}, language: ${context.attempt.language ?? 'unknown'}`);
  const trail = context.attempt.stateHistory.map((t) => t.toState).join(' -> ');
  lines.push(`State trail: ${trail}`);
  if (context.previousAttempts.length > 0) {
    lines.push(
      `Previous attempts on this problem: ${context.previousAttempts
        .map((a) => `${a.attemptId.slice(0, 12)}… [${a.finalState}]`)
        .join(', ')}`,
    );
  }
  lines.push('');
  lines.push(`## Current code (${context.code.language ?? 'unknown'})`);
  if (context.code.reconstructedSource !== null && context.code.reconstructionOk) {
    lines.push('Exact source, deterministically reconstructed from the attempt baseline plus the learner edits:');
    lines.push('```\n' + truncate(context.code.reconstructedSource, MAX_PROMPT_SOURCE_CHARS) + '\n```');
  } else if (context.code.currentText !== null) {
    lines.push('Latest checkpoint snapshot (reconstruction unavailable — treat as approximate state, not exact replay):');
    lines.push('```\n' + truncate(context.code.currentText, MAX_PROMPT_SOURCE_CHARS) + '\n```');
  } else {
    lines.push('(no code observed yet)');
  }
  lines.push('');
  lines.push(
    '## Baseline (OBSERVED STARTING STATE — predates this attempt, NOT learner-authored evidence)',
  );
  if (context.code.baseline) {
    lines.push(`Snapshot taken at ${context.code.baseline.timestamp}:`);
    lines.push('```\n' + truncate(context.code.baseline.snapshot, MAX_PROMPT_SOURCE_CHARS) + '\n```');
  } else {
    lines.push('(no baseline captured)');
  }
  if (context.code.evolutionDiffs.length > 0) {
    lines.push('');
    lines.push('## Code evolution (derived diffs between checkpoints, newest last)');
    for (const step of context.code.evolutionDiffs) {
      lines.push(`### ${step.label}${step.truncated ? ' [truncated]' : ''}`);
      lines.push('```diff\n' + step.diff + '\n```');
    }
  }
  if (context.executions.length > 0) {
    lines.push('');
    lines.push('## Execution evidence (local runs/diagnostics, NOT online-judge verdicts)');
    for (const e of context.executions.slice(-15)) {
      lines.push(`- [${e.timestamp}] ${e.kind}: ${e.summary}`);
    }
  }
  if (context.conversation.length > 0) {
    lines.push('');
    lines.push('## Prior conversation with the learner (resolves ambiguity — build on it)');
    for (const m of context.conversation) {
      lines.push(`${m.role === 'coach' ? 'CodeSense' : 'Learner'}: ${m.text}`);
    }
  }
  if (context.learnerContext.notes.length > 0) {
    lines.push('');
    lines.push('## Learner context');
    for (const note of context.learnerContext.notes) {
      lines.push(`- ${note}`);
    }
  }
  // Phase E personalized-coach briefing: deterministic learner-aware slice
  // (relevant states, recent excerpts, previous intervention + outcome).
  // Absent when the coach layer has nothing to add; the model still owns
  // the final intervention choice within the contract above.
  const briefing = context.coachBriefing ?? null;
  if (briefing) {
    lines.push('');
    lines.push(renderCoachBriefing(briefing));
  }
  return lines.join('\n');
}
