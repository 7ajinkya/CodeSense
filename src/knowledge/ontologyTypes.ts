/**
 * Phase C canonical knowledge ontology — types only (no data, no enums-as-taxonomy).
 *
 * Design rules (see the Phase C prompt):
 * - The CodeSense ontology is CANONICAL. Curriculum sources (AlgoZenith,
 *   LeetCode, ...) are inputs/mappings, never the taxonomy itself.
 * - The ontology is DATA-DRIVEN: entities live in `ontologyCatalog.ts` as
 *   plain data. Adding knowledge means adding data, never editing a
 *   TypeScript enum or rewriting architecture. The `KnowledgeEntityType`
 *   union below is the fixed conceptual vocabulary (topic/concept/...),
 *   not the taxonomy — analogous to `AttemptState`, not to a skill list.
 * - The representation is a GRAPH, not a rigid tree: entities carry no
 *   single parent; relationships are many-to-many records.
 * - Stable IDs (`topic.graphs`, `framework.bfs`, ...): names may change,
 *   IDs must not. Classification references IDs, never display names.
 * - Implementation/debugging knowledge is a separate cross-cutting
 *   `tooling` layer (`capability` entities), never forced into the DSA
 *   topic hierarchy.
 */

export const ONTOLOGY_VERSION = '1';

/** Conceptual vocabulary for knowledge entities (fixed, data fills it in). */
export type KnowledgeEntityType =
  | 'topic'
  | 'concept'
  | 'framework'
  | 'form'
  | 'pattern'
  | 'variant'
  | 'tactic'
  | 'capability';

export const KNOWLEDGE_ENTITY_TYPES: readonly KnowledgeEntityType[] = [
  'topic',
  'concept',
  'framework',
  'form',
  'pattern',
  'variant',
  'tactic',
  'capability',
];

export function isKnownKnowledgeEntityType(value: unknown): value is KnowledgeEntityType {
  return (
    typeof value === 'string' && (KNOWLEDGE_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Which layer an entity belongs to. `dsa` is the canonical DSA knowledge
 * hierarchy; `tooling` is the separate cross-cutting capability layer
 * (language/STL APIs, implementation mechanics). Debugging/implementation
 * evidence layers for Phase D attach here, never inside DSA topics.
 */
export type KnowledgeLayer = 'dsa' | 'tooling';

export function isKnownKnowledgeLayer(value: unknown): value is KnowledgeLayer {
  return value === 'dsa' || value === 'tooling';
}

export interface KnowledgeEntity {
  /** Stable canonical id, e.g. `framework.bfs`. Never renamed. */
  id: string;
  type: KnowledgeEntityType;
  /** Display name (mutable — never use as a reference). */
  name: string;
  /** One-paragraph generic description (no source-specific claims). */
  description: string;
  /** Alternate source wordings that mean THIS entity (no duplicate entities). */
  aliases?: string[];
  /** Defaults to `dsa` when omitted. */
  layer?: KnowledgeLayer;
}

/**
 * Small, explicit relationship vocabulary. `parent_of`/`child_of` cover
 * conceptually-hierarchical presentation; everything else is a graph edge.
 * Do not invent new types to look sophisticated — extend only with cause.
 */
export type KnowledgeRelationshipType =
  | 'parent_of'
  | 'child_of'
  | 'related_to'
  | 'prerequisite_of'
  | 'form_of'
  | 'variant_of'
  | 'uses'
  | 'often_combined_with';

export const KNOWLEDGE_RELATIONSHIP_TYPES: readonly KnowledgeRelationshipType[] = [
  'parent_of',
  'child_of',
  'related_to',
  'prerequisite_of',
  'form_of',
  'variant_of',
  'uses',
  'often_combined_with',
];

export function isKnownKnowledgeRelationshipType(
  value: unknown,
): value is KnowledgeRelationshipType {
  return (
    typeof value === 'string' &&
    (KNOWLEDGE_RELATIONSHIP_TYPES as readonly string[]).includes(value)
  );
}

export interface KnowledgeRelationship {
  fromId: string;
  type: KnowledgeRelationshipType;
  toId: string;
  note?: string;
}

/** Classification confidence — uncertainty is preserved, never rounded up. */
export type ClassificationConfidence = 'high' | 'medium' | 'low';

export const CLASSIFICATION_CONFIDENCES: readonly ClassificationConfidence[] = [
  'high',
  'medium',
  'low',
];

export function isKnownClassificationConfidence(
  value: unknown,
): value is ClassificationConfidence {
  return (
    typeof value === 'string' &&
    (CLASSIFICATION_CONFIDENCES as readonly string[]).includes(value)
  );
}

/** Who/what produced a knowledge claim (provenance, never secrets). */
export type ClassificationSource = 'ai' | 'human-curated' | 'inferred' | 'imported-curriculum';

export const CLASSIFICATION_SOURCES: readonly ClassificationSource[] = [
  'ai',
  'human-curated',
  'inferred',
  'imported-curriculum',
];

export function isKnownClassificationSource(value: unknown): value is ClassificationSource {
  return (
    typeof value === 'string' && (CLASSIFICATION_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * How external curriculum organization maps onto canonical knowledge.
 * The source hierarchy (source → category/module → item) is preserved
 * verbatim; only `entityId` points at the canonical ontology.
 *
 * `unknown` status means the source label is preserved WITHOUT an invented
 * canonical meaning (e.g. "Form 2", "Application 3", bare problem titles).
 * Such items can be mapped later when their meaning becomes known.
 */
export type CurriculumMappingStatus = 'mapped' | 'unknown';

export function isKnownCurriculumMappingStatus(
  value: unknown,
): value is CurriculumMappingStatus {
  return value === 'mapped' || value === 'unknown';
}

export interface CurriculumSourceMapping {
  /** Stable mapping id, e.g. `az-graph-l1-multisource-bfs`. */
  mappingId: string;
  /** Curriculum source, e.g. `AlgoZenith`. Never canonical. */
  source: string;
  /** Source-side category/module, e.g. `Graph Level 1`. */
  sourceCategory: string;
  /** Raw source-side item label, preserved verbatim, e.g. `Form 2`. */
  sourceItem: string;
  /** Canonical entity, or null when unresolved (`unknown` status). */
  entityId: string | null;
  status: CurriculumMappingStatus;
  confidence?: ClassificationConfidence | null;
  note?: string;
}

/**
 * Normalize a name/alias for lookup: case-insensitive, punctuation and
 * spacing collapsed, so "Multi-source BFS", "Multi Source BFS" and
 * "multiple source bfs" style variants resolve identically. Lookup
 * normalization only — canonical names/IDs are never rewritten.
 */
export function normalizeKnowledgeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
