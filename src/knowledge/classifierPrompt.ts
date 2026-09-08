import type { KnowledgeGraph } from './ontologyStore';
import { KnowledgeEntityType } from './ontologyTypes';
import type { ClassificationInput } from './classifier';

/**
 * Phase C classifier prompt design (mirrors `ai/aiPrompt.ts` ownership:
 * classification philosophy lives HERE and nowhere else).
 *
 * The model classifies the PROBLEM's knowledge requirements. It is
 * explicitly forbidden from inferring anything about the learner — no
 * mastery, weakness, tactic usage, or debugging behavior. The strict
 * validator (`validateClassificationPayload`) rejects such output; this
 * prompt teaches the distinction up front so failures stay rare.
 */

export const CLASSIFICATION_PROMPT_VERSION = 1;

/** Hard caps keep classification prompts bounded (problem-only content). */
export const MAX_CLASSIFICATION_STATEMENT_CHARS = 3000;
export const MAX_CLASSIFICATION_CONSTRAINTS_CHARS = 1000;
export const MAX_CLASSIFICATION_EXAMPLES = 4;
export const MAX_CLASSIFICATION_LABELS_CHARS = 500;

export const CLASSIFICATION_SYSTEM_PROMPT = `You are CodeSense's problem classifier. Given ONE data-structures-and-algorithms problem, decide what reusable knowledge the problem exercises.

Answer ONLY this question: "What knowledge does this problem exercise?"
NEVER answer: "How good is the learner at it?" There is no learner here — only a problem statement. Do NOT output mastery, proficiency, weakness, strength, tactic usage, debugging behavior, or any claim about a person. Hypotheses about a learner are out of scope and will be rejected.

How to classify:
- Ground every claim in the ACTUAL statement, constraints, and examples — not in title keywords. "Minimum maximum difference" may be search-on-answer or greedy; read the problem.
- Use ONLY entity IDs from the allowed list for your ontology version. Never invent IDs, never use display names as IDs, never guess at IDs you have not seen.
- Confidence is per claim: high = the statement directly shows it; medium = strongly suggested but an alternative reading exists; low = a plausible guess. When unsure, use low or omit the claim — preserving uncertainty beats inventing precision.
- A problem can exercise several frameworks or forms at once (e.g. graphs + prefix sums). List each once, in its correct bucket.
- Relevant tactics are techniques the problem REWARDS (e.g. visited-on-enqueue for BFS grids), never claims about what anyone did.
- Relevant curriculum modules reference the source's own organization (source, category, item). When source terminology is unrecognized ("Form 2", "Application 3", a bare title), report it as status unknown with entityId null — never invent a canonical meaning.

Response contract (MUST be a single JSON object, no other text):
{
  "topics": [{"entityId": string, "confidence": "high"|"medium"|"low"}],
  "concepts": [...same shape...],
  "frameworks": [...same shape...],
  "forms": [...same shape...],
  "patterns": [...same shape...],
  "variants": [...same shape...],
  "tactics": [...same shape...],
  "prerequisites": [...same shape...],
  "solutionFamilies": [...same shape...],
  "curriculumMappings": [{"source": string, "sourceCategory": string|null, "sourceItem": string, "entityId": string|null, "status": "mapped"|"unknown", "confidence": "high"|"medium"|"low"|null}],
  "confidence": "high"|"medium"|"low"
}
Rules: every entityId must come from the allowed list and match its bucket (topics hold topic IDs, forms hold form IDs, and so on). Omit empty buckets or send []. mapped curriculum entries need a known entityId; unknown entries need entityId null. Never include keys outside this contract that describe a learner.`;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + '\n…[truncated for prompt budget]';
}

/**
 * Render the allowed entity IDs grouped by classification bucket.
 * Deterministic and bounded; grounding the model is what makes strict
 * entity validation meaningful instead of punitive.
 */
export function renderEntityReference(graph: KnowledgeGraph): string {
  const bucketFor: Record<string, KnowledgeEntityType[]> = {
    topics: ['topic'],
    concepts: ['concept'],
    frameworks: ['framework'],
    forms: ['form'],
    patterns: ['pattern'],
    variants: ['variant'],
    tactics: ['tactic', 'capability'],
    prerequisites: ['topic', 'concept', 'framework', 'form', 'pattern', 'variant', 'tactic', 'capability'],
    solutionFamilies: ['framework', 'concept', 'form', 'pattern'],
  };
  const lines: string[] = [];
  const buckets = [
    'topics',
    'concepts',
    'frameworks',
    'forms',
    'patterns',
    'variants',
    'tactics',
    'prerequisites',
    'solutionFamilies',
  ];
  for (const bucket of buckets) {
    const types = bucketFor[bucket];
    const entities = graph
      .listEntities()
      .filter((e) => types.includes(e.type))
      .sort((a, b) => a.id.localeCompare(b.id));
    lines.push(`${bucket}:`);
    for (const entity of entities) {
      lines.push(`- ${entity.id} — ${entity.name}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render ONLY problem information for the classifier: title, statement,
 * constraints, examples, and source-provided labels (marked explicitly as
 * untrusted hints). Never workspace content, never attempt or learner data —
 * classification inputs are problem-scoped by construction.
 */
export function renderProblemForClassification(input: ClassificationInput): string {
  const lines: string[] = [];
  lines.push(`Problem: ${input.title ?? '(untitled)'}`);
  lines.push(`Provider: ${input.provider}`);
  lines.push(`Reference: ${input.sourceUrl}`);
  if (input.difficulty) {
    lines.push(`Difficulty label: ${input.difficulty}`);
  }
  if (input.topics.length > 0) {
    lines.push(
      `Source-provided labels (untrusted hints, may be wrong): ${truncate(input.topics.join(', '), MAX_CLASSIFICATION_LABELS_CHARS)}`,
    );
  }
  if (input.statement) {
    lines.push(`Statement:\n${truncate(input.statement, MAX_CLASSIFICATION_STATEMENT_CHARS)}`);
  }
  if (input.constraints) {
    lines.push(`Constraints:\n${truncate(input.constraints, MAX_CLASSIFICATION_CONSTRAINTS_CHARS)}`);
  }
  if (input.examples.length > 0) {
    const examples = input.examples
      .slice(0, MAX_CLASSIFICATION_EXAMPLES)
      .map((e, i) => `Example ${i + 1}:\nInput: ${e.input}\nOutput: ${e.output}`)
      .join('\n');
    lines.push(examples);
  }
  return lines.join('\n');
}
