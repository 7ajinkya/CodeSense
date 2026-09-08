import { expect } from 'chai';
import {
  AIConversationMessage,
  AIEvaluation,
  EvaluationTriggerKind,
  isKnownDiagnosticConfidence,
  validateAIDiagnosis,
  validateAIEvaluation,
} from 'codesense/ai/aiTypes';
import {
  COACHING_PROMPT_VERSION,
  COACHING_SYSTEM_PROMPT,
} from 'codesense/ai/aiPrompt';
import { isAwaitingLearnerResponse } from 'codesense/ai/conversationStatus';
import { coachMessage, FakeReasoner, learnerMessage } from 'codesense/ai/reasoners';
import { EvaluationPorts, runAiEvaluation } from 'codesense/ai/evaluationRunner';
import { AIContext, buildAIContext } from 'codesense/context/aiContext';
import { createManualProblem } from 'codesense/problems/problem';
import { createAttempt } from 'codesense/attempts/attempt';

/**
 * Phase B — Coaching Diagnosis Engine.
 *
 * Machine-enforced properties live here: the diagnostic contract shape,
 * strict-but-practical validation, the explicit response-expectation flag,
 * and idle suppression keyed on that flag (never on interventionType).
 * Model-behavior scenarios (B7.1-9) are pinned as prompt-content tests:
 * the prompt is the mechanism that teaches the model those distinctions.
 */

function scriptedDiagnosis(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    observedEvidence: ['loop bound changed in edit v3 without an empty-input guard'],
    hypothesis: 'The learner may not have considered the empty-input edge case.',
    confidence: 'medium',
    unknowns: ['Whether the learner knows the empty-input behavior is required'],
    recommendedInteraction: 'SOCRATIC_QUESTION',
    ...overrides,
  };
}

function scriptedEvaluation(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    shouldIntervene: true,
    interventionType: 'SOCRATIC_QUESTION',
    urgency: 'low',
    message: 'What happens to your invariant on line 3 when the input is empty?',
    reasoningSignals: {
      observedApproach: 'Two-pointer scan',
      suspectedIssue: 'Empty-input edge case unhandled',
      confidence: 0.7,
      relevantEvidence: ['edit v3 changed loop bound'],
    },
    diagnosis: scriptedDiagnosis(),
    requiresLearnerResponse: true,
    ...overrides,
  };
}

const VALIDATE_OPTS = {
  attemptId: 'att_b',
  triggerKind: 'idle' as EvaluationTriggerKind,
  timestamp: '2026-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// B6: diagnosis validation
// ---------------------------------------------------------------------------

describe('Phase B diagnosis validation (strict, practical)', () => {
  it('accepts a complete valid diagnosis with the flag preserved', () => {
    const evaluation = validateAIEvaluation(scriptedEvaluation(), VALIDATE_OPTS);
    expect(evaluation).to.not.be.null;
    expect(evaluation!.diagnosis.observedEvidence.length).to.be.greaterThan(0);
    expect(evaluation!.diagnosis.hypothesis.length).to.be.greaterThan(0);
    expect(evaluation!.diagnosis.confidence).to.equal('medium');
    expect(evaluation!.diagnosis.recommendedInteraction).to.equal('SOCRATIC_QUESTION');
    expect(evaluation!.requiresLearnerResponse).to.be.true;
  });

  it('rejects a missing or malformed diagnosis block', () => {
    const missing = { ...scriptedEvaluation() };
    delete (missing as Record<string, unknown>).diagnosis;
    expect(validateAIEvaluation(missing, VALIDATE_OPTS)).to.be.null;
    expect(validateAIEvaluation(scriptedEvaluation({ diagnosis: null }), VALIDATE_OPTS)).to.be.null;
    expect(validateAIEvaluation(scriptedEvaluation({ diagnosis: 'looks fine' }), VALIDATE_OPTS)).to.be.null;
    expect(validateAIEvaluation(scriptedEvaluation({ diagnosis: {} }), VALIDATE_OPTS)).to.be.null;
  });

  it('rejects invalid confidence while accepting low/medium/high', () => {
    expect(isKnownDiagnosticConfidence('low')).to.be.true;
    expect(isKnownDiagnosticConfidence('medium')).to.be.true;
    expect(isKnownDiagnosticConfidence('high')).to.be.true;
    expect(isKnownDiagnosticConfidence('extreme')).to.be.false;
    for (const bad of ['extreme', 'Medium', '', 0.8, null]) {
      expect(
        validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ confidence: bad }) }), VALIDATE_OPTS),
        JSON.stringify(bad),
      ).to.be.null;
    }
  });

  it('requires observed evidence exactly when intervening', () => {
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ observedEvidence: [] }) }), VALIDATE_OPTS),
    ).to.be.null;
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ observedEvidence: ['  '] }) }), VALIDATE_OPTS),
    ).to.be.null;
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ observedEvidence: [42] }) }), VALIDATE_OPTS),
    ).to.be.null;
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ observedEvidence: 'trust me' }) }), VALIDATE_OPTS),
    ).to.be.null;
    // A silent look may carry no evidence — still a fully valid outcome.
    const silent = validateAIEvaluation(
      scriptedEvaluation({
        shouldIntervene: false,
        interventionType: 'NONE',
        message: '',
        diagnosis: scriptedDiagnosis({ observedEvidence: [], hypothesis: '' }),
        requiresLearnerResponse: false,
      }),
      VALIDATE_OPTS,
    );
    expect(silent).to.not.be.null;
    expect(silent!.shouldIntervene).to.be.false;
  });

  it('requires a real hypothesis exactly when intervening', () => {
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ hypothesis: '' }) }), VALIDATE_OPTS),
    ).to.be.null;
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ hypothesis: 42 }) }), VALIDATE_OPTS),
    ).to.be.null;
  });

  it('requires well-formed unknowns and a known recommended interaction', () => {
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ unknowns: 'maybe' }) }), VALIDATE_OPTS),
    ).to.be.null;
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ unknowns: [''] }) }), VALIDATE_OPTS),
    ).to.be.null;
    expect(
      validateAIEvaluation(scriptedEvaluation({ diagnosis: scriptedDiagnosis({ recommendedInteraction: 'MIND_READ' }) }), VALIDATE_OPTS),
    ).to.be.null;
    const noneNext = validateAIEvaluation(
      scriptedEvaluation({ diagnosis: scriptedDiagnosis({ recommendedInteraction: 'NONE' }) }),
      VALIDATE_OPTS,
    );
    expect(noneNext).to.not.be.null;
    expect(validateAIDiagnosis(scriptedDiagnosis(), true)).to.not.be.null;
  });

  it('rejects malformed requiresLearnerResponse but coerces the no-action shape', () => {
    for (const bad of ['yes', 1, null]) {
      expect(
        validateAIEvaluation(scriptedEvaluation({ requiresLearnerResponse: bad }), VALIDATE_OPTS),
        JSON.stringify(bad),
      ).to.be.null;
    }
    const missing = { ...scriptedEvaluation() };
    delete (missing as Record<string, unknown>).requiresLearnerResponse;
    expect(validateAIEvaluation(missing, VALIDATE_OPTS)).to.be.null;
    // shouldIntervene=false coerces to the single silent shape, flag included.
    const coerced = validateAIEvaluation(
      scriptedEvaluation({
        shouldIntervene: false,
        interventionType: 'HINT',
        message: 'stale',
        requiresLearnerResponse: true,
      }),
      VALIDATE_OPTS,
    );
    expect(coerced).to.not.be.null;
    expect(coerced!.interventionType).to.equal('NONE');
    expect(coerced!.requiresLearnerResponse).to.be.false;
  });

  it('keeps response expectation separate from intervention type', () => {
    // B7.10: a real question mislabeled HINT still represents its state.
    const hintAsking = validateAIEvaluation(
      scriptedEvaluation({
        interventionType: 'HINT',
        message: 'What should the base case return here?',
        requiresLearnerResponse: true,
      }),
      VALIDATE_OPTS,
    );
    expect(hintAsking).to.not.be.null;
    expect(hintAsking!.interventionType).to.equal('HINT');
    expect(hintAsking!.requiresLearnerResponse).to.be.true;
    const explaining = validateAIEvaluation(
      scriptedEvaluation({
        interventionType: 'EXPLANATION',
        message: 'Here is how the queue API works.',
        diagnosis: scriptedDiagnosis({ recommendedInteraction: 'EXPLANATION' }),
        requiresLearnerResponse: false,
      }),
      VALIDATE_OPTS,
    );
    expect(explaining).to.not.be.null;
    expect(explaining!.requiresLearnerResponse).to.be.false;
  });
});

// ---------------------------------------------------------------------------
// B4/B5: evidence-first prompt pins the behavioral policy in prose
// ---------------------------------------------------------------------------

describe('Phase B evidence-first prompt (behavioral policy in prose)', () => {
  it('bumps the prompt version and carries the diagnosis contract', () => {
    expect(COACHING_PROMPT_VERSION).to.equal(4);
    for (const key of ['diagnosis', 'observedEvidence', 'unknowns', 'requiresLearnerResponse']) {
      expect(COACHING_SYSTEM_PROMPT, key).to.contain(key);
    }
    expect(COACHING_SYSTEM_PROMPT).to.contain('confidence in the HYPOTHESIS');
  });

  it('teaches observation-vs-hypothesis separation (B7.1, B7.3, B7.4)', () => {
    expect(COACHING_SYSTEM_PROMPT).to.contain('implementation slip');
    expect(COACHING_SYSTEM_PROMPT).to.contain('NOT of conceptual weakness');
    expect(COACHING_SYSTEM_PROMPT).to.contain("I can't tell yet whether");
    expect(COACHING_SYSTEM_PROMPT).to.contain('ASK a targeted question instead of assuming');
  });

  it('teaches explicit learner reports beat inference (B7.2, B7.8)', () => {
    expect(COACHING_SYSTEM_PROMPT).to.contain('stronger evidence than anything you infer');
    expect(COACHING_SYSTEM_PROMPT).to.contain('do not lecture on BFS');
  });

  it('teaches single-encounter humility (B7.5, B7.6, B7.7)', () => {
    expect(COACHING_SYSTEM_PROMPT).to.contain('proves no lasting weakness');
    expect(COACHING_SYSTEM_PROMPT).to.contain('proves nothing durable');
    expect(COACHING_SYSTEM_PROMPT).to.contain('responsiveness');
  });

  it('teaches grounded repetition claims (B7.9) and low-confidence questions', () => {
    expect(COACHING_SYSTEM_PROMPT).to.contain('actually present in the supplied history');
    expect(COACHING_SYSTEM_PROMPT).to.contain('Low confidence should lead with a diagnostic Socratic question');
    expect(COACHING_SYSTEM_PROMPT).to.contain('Never invent learner history');
  });
});

// ---------------------------------------------------------------------------
// B2/B3: suppression follows the explicit flag, never the type
// ---------------------------------------------------------------------------

describe('Phase B suppression on explicit response expectation', () => {
  function evaluated(
    attemptId: string,
    overrides: Partial<Record<string, unknown>> = {},
  ): AIEvaluation {
    const evaluation = validateAIEvaluation(scriptedEvaluation(overrides), {
      attemptId,
      triggerKind: 'idle',
      timestamp: '2026-01-01T00:10:00.000Z',
    });
    if (!evaluation) {
      throw new Error('fixture evaluation must validate');
    }
    return evaluation;
  }

  function linked(attemptId: string, evaluation: AIEvaluation, text: string, timestamp: string) {
    return coachMessage(attemptId, text, { timestamp, evaluationId: evaluation.evaluationId });
  }

  it('suppresses a HINT that expects a reply (the Phase-A edge case)', () => {
    const hintAsking = evaluated('att_b', {
      interventionType: 'HINT',
      message: 'What should the base case return here?',
      requiresLearnerResponse: true,
    });
    const conversation: AIConversationMessage[] = [
      linked('att_b', hintAsking, 'What should the base case return here?', '2026-01-01T00:01:00.000Z'),
    ];
    expect(isAwaitingLearnerResponse(conversation, [hintAsking])).to.be.true;
  });

  it('lets informational turns through regardless of type', () => {
    const explaining = evaluated('att_b', {
      interventionType: 'EXPLANATION',
      message: 'Here is how the queue API works.',
      diagnosis: scriptedDiagnosis({ recommendedInteraction: 'EXPLANATION' }),
      requiresLearnerResponse: false,
    });
    const conversation: AIConversationMessage[] = [
      linked('att_b', explaining, 'Here is how the queue API works.', '2026-01-01T00:01:00.000Z'),
    ];
    expect(isAwaitingLearnerResponse(conversation, [explaining])).to.be.false;
    // Separation holds in both directions: even a QUESTION need not await.
    const questionNoReply = evaluated('att_b', {
      interventionType: 'SOCRATIC_QUESTION',
      requiresLearnerResponse: false,
    });
    const conversation2: AIConversationMessage[] = [
      linked('att_b', questionNoReply, 'Rhetorical nudge, keep going.', '2026-01-01T00:01:00.000Z'),
    ];
    expect(isAwaitingLearnerResponse(conversation2, [questionNoReply])).to.be.false;
  });

  it('clears on learner reply and fails open without the flag', () => {
    const hintAsking = evaluated('att_b', {
      interventionType: 'HINT',
      message: 'What should the base case return here?',
      requiresLearnerResponse: true,
    });
    const conversation: AIConversationMessage[] = [
      linked('att_b', hintAsking, 'What should the base case return here?', '2026-01-01T00:01:00.000Z'),
      learnerMessage('att_b', 'It should return 0.', '2026-01-01T00:02:00.000Z'),
    ];
    expect(isAwaitingLearnerResponse(conversation, [hintAsking])).to.be.false;
    // Legacy records predate the flag: evaluate normally, never suppress.
    const legacy = { ...hintAsking };
    delete (legacy as Partial<AIEvaluation>).requiresLearnerResponse;
    const legacyConversation: AIConversationMessage[] = [
      linked('att_b', hintAsking, 'What should the base case return here?', '2026-01-01T00:01:00.000Z'),
    ];
    expect(
      isAwaitingLearnerResponse(legacyConversation, [legacy as AIEvaluation]),
    ).to.be.false;
  });
});

// ---------------------------------------------------------------------------
// Runner flow: diagnosis and flag survive persistence untouched
// ---------------------------------------------------------------------------

describe('Phase B runner flow (diagnosis passes through)', () => {
  function fixtureContext(attemptId = 'att_b'): AIContext {
    const problem = createManualProblem('https://leetcode.com/problems/two-sum/', {
      title: 'Two Sum',
      statement: 'Add two numbers.',
    });
    const attempt = createAttempt({ attemptId, problemId: problem.problemId, sessionId: 'ses_b' });
    return buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: [],
      checkpoints: [],
      sessionEvents: [],
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  it('persists diagnosis and the response flag with the evaluation', async () => {
    const saved: AIEvaluation[] = [];
    const appended: AIConversationMessage[] = [];
    const ports: EvaluationPorts = {
      nowIso: () => '2026-01-01T00:10:00.000Z',
      getActiveAttempt: () => ({
        attempt: createAttempt({ attemptId: 'att_b', problemId: 'prob_b', sessionId: 'ses_b' }),
        problem: createManualProblem('https://leetcode.com/problems/two-sum/', {
          title: 'Two Sum',
          statement: 'Add two numbers.',
        }),
      }),
      buildContext: async () => fixtureContext('att_b'),
      reasoner: new FakeReasoner([scriptedEvaluation()]),
      saveEvaluation: async (evaluation: AIEvaluation) => {
        saved.push(evaluation);
      },
      appendConversation: async (message: AIConversationMessage) => {
        appended.push(message);
      },
      isAttemptStillActive: (attemptId: string) => attemptId === 'att_b',
      timeoutMs: 1000,
    };
    const outcome = await runAiEvaluation(ports, {
      attemptId: 'att_b',
      triggerKind: 'reply',
      reason: 'learner reply',
    });
    expect(outcome.status).to.equal('evaluated');
    if (outcome.status !== 'evaluated') {
      return;
    }
    expect(outcome.displayed).to.be.true;
    expect(saved.length).to.equal(1);
    expect(saved[0].diagnosis.confidence).to.equal('medium');
    expect(saved[0].diagnosis.observedEvidence.length).to.be.greaterThan(0);
    expect(saved[0].requiresLearnerResponse).to.be.true;
    expect(appended.length).to.equal(1);
  });
});
