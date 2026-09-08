import type { CoachContext } from './coachTypes';

/**
 * Phase E prompt surface: a bounded "coach briefing" rendered from the
 * deterministic CoachContext, plus the system-prompt appendix that teaches
 * the model to USE it. Philosophy still lives with the base prompt in
 * `ai/aiPrompt.ts`; this module only adds the learner-aware layer.
 *
 * Bounds: the briefing is capped section by section so prompt size stays
 * predictable no matter how much history exists. Entity IDs are stable
 * references; per-claim confidence travels with every statement.
 */

export const MAX_BRIEFING_CHARS = 3000;
export const MAX_BRIEFING_EVIDENCE = 9;
export const MAX_BRIEFING_RELEVANCE = 8;

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Render the deterministic coaching briefing as prompt markdown.
 * Deterministic: same context → same text. Empty contexts render a
 * one-line "no learner history" note rather than nothing, so the model
 * explicitly knows the difference between "no data" and "missing data".
 */
export function renderCoachBriefing(context: CoachContext): string {
  const lines: string[] = [];
  lines.push('## Coach briefing (CodeSense learner-aware context — weigh, do not blindly obey)');
  const hasLearnerData =
    context.learnerRelevance.length > 0 ||
    context.recentEvidence.length > 0 ||
    context.activeMistakeCategories.length > 0;
  if (!hasLearnerData && !context.previousIntervention) {
    lines.push('No prior learner history on record for these knowledge areas. Coach from current evidence only; single encounters prove nothing durable.');
  }
  if (context.learnerRelevance.length > 0) {
    lines.push('Learner state on this problem\u2019s knowledge (status + confidence, qualitative — never percentages):');
    for (const relevance of context.learnerRelevance.slice(0, MAX_BRIEFING_RELEVANCE)) {
      const dims = relevance.activeDimensions.length > 0 ? ` [${relevance.activeDimensions.join(', ')}]` : '';
      lines.push(`- ${relevance.entityId}: ${relevance.status} (confidence ${relevance.statusConfidence})${dims}`);
    }
    lines.push('Do NOT reteach entities with sustained positive evidence unless current behavior contradicts it. Target the actual gap by entity, not the whole topic.');
  }
  if (context.prerequisiteStatuses.some((p) => p.status !== 'strong' && p.status !== 'demonstrated')) {
    const gaps = context.prerequisiteStatuses
      .filter((p) => p.status !== 'strong' && p.status !== 'demonstrated')
      .map((p) => p.entityId);
    if (gaps.length > 0) {
      lines.push(`Prerequisite footing looks thin on: ${gaps.join(', ')}. If the difficulty is conceptual, check there first.`);
    }
  }
  if (context.activeMistakeCategories.length > 0) {
    lines.push(
      `Recurring implementation pattern(s) on record here: ${context.activeMistakeCategories.join(', ')}. ` +
        'If the current code shows the same habit, name the habit — do not reteach the algorithm underneath it.',
    );
  }
  if (context.recentEvidence.length > 0) {
    lines.push('Recent evidence excerpts (newest first, capped):');
    const ordered = [...context.recentEvidence]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, MAX_BRIEFING_EVIDENCE);
    for (const excerpt of ordered) {
      lines.push(`- [${excerpt.timestamp}] ${excerpt.entityId} ${excerpt.evidenceType} (${excerpt.confidence}): ${clip(excerpt.observation, 200)}`);
    }
  }
  if (context.previousIntervention) {
    const prev = context.previousIntervention;
    const outcome = context.previousOutcome;
    let outcomeNote = 'outcome not yet observable';
    if (outcome) {
      outcomeNote =
        outcome.outcome === 'progressed'
          ? 'learner replied and later reached an accepted outcome'
          : outcome.outcome === 'abandoned'
            ? 'attempt was later abandoned'
            : outcome.outcome === 'no-progress'
              ? 'learner replied but no accepted outcome followed'
              : 'no reply and no terminal outcome yet';
    }
    lines.push(
      `Previous intervention on this attempt: ${prev.interventionType} (${prev.triggerKind}); outcome so far: ${outcomeNote}. ` +
        'If it did not visibly help, change strategy or step up one rung — do not repeat the same move.',
    );
  }
  if (context.signals.asksForSolution) {
    lines.push('The learner explicitly asked for the solution. Honor the request within bounds when they are genuinely stuck; never force another hint instead.');
  } else if (context.signals.asksForExplanation) {
    lines.push('The learner explicitly asked for an explanation. Answer directly rather than forcing a hint first.');
  }
  if (context.abandonmentStreak >= 2) {
    lines.push(
      `Note: ${context.abandonmentStreak} consecutive abandonments on this problem. This is a signal about the interaction, not a verdict on the learner — reconnect with a small step and verify understanding before continuing.`,
    );
  }
  const rendered = lines.join('\n');
  return rendered.length <= MAX_BRIEFING_CHARS ? rendered : rendered.slice(0, MAX_BRIEFING_CHARS - 1).trimEnd() + '…';
}

/**
 * Phase E appendix to the coaching system prompt. Additive by design:
 * every pre-existing instruction keeps working; this layer adds
 * learner-aware diagnosis discipline, longitudinal personalization,
 * outcome-aware strategy, emotional attunement bounds, and solution
 * restraint. Bumped COACHING_PROMPT_VERSION alongside (see aiPrompt).
 */
export const COACHING_PHASE_E_APPENDIX = `How to coach a learner you have history with (personalized coaching):
- You receive a Coach briefing summarizing evidence-backed learner state for THIS problem's knowledge areas. Treat it as orientation, not truth: statuses are qualitative beliefs with confidence, and a single past encounter proves nothing durable either way.
- Never reteach what shows sustained positive evidence unless the current code contradicts it. Target the actual gap by entity: if BFS is strong but multi-source BFS is developing, talk about multiple starting points, not BFS itself.
- Distinguish difficulty type before acting: a recurring implementation habit (e.g. unsafe midpoint, forgotten visited marking) is surfaced as a habit to fix, never as a conceptual weakness. An unfamiliar variant is a recognition/transfer question first, not proof of a gap.
- When diagnostic uncertainty is high — rival explanations open, low confidence — ask ONE targeted question that separates them instead of teaching a presumed weakness. Reducing uncertainty IS the intervention.
- Track what you already tried on this attempt (previous intervention + outcome are briefed). If it did not visibly help, change strategy or step up exactly one rung. Never repeat the same hint twice. Acknowledge real progress explicitly and specifically; never emit mechanical praise.
- Honor explicit requests: an asked-for explanation gets an explanation, not a forced hint. A full solution is only on the table when the learner explicitly asks AND there is corroborated struggle (stuck state, failed attempts, or repeated no-progress) — canonical solution knowledge never justifies revealing it on its own.
- Read emotional signals only from what is actually in front of you (their words, stuck states, abandonment streaks). Respond with empathy proportionate to evidence — a brief acknowledgement plus a smaller next step for frustration — and never label the learner (no "you are weak at X", no permanent traits from single interactions).
- Keep messages conversational and tight, like a senior developer pair-programming: casual, friendly, technically excellent, occasionally lightly humorous when natural. Challenge capable learners; simplify only when prerequisites are genuinely missing.`;
