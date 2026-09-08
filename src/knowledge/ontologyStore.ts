import {
  CurriculumSourceMapping,
  KNOWLEDGE_RELATIONSHIP_TYPES,
  KnowledgeEntity,
  KnowledgeEntityType,
  KnowledgeRelationship,
  KnowledgeRelationshipType,
  ONTOLOGY_VERSION,
  isKnownKnowledgeEntityType,
  isKnownKnowledgeRelationshipType,
  normalizeKnowledgeName,
} from './ontologyTypes';
import { ONTOLOGY_ENTITIES } from './ontologyCatalogEntities';
import { ONTOLOGY_CURRICULUM_MAPPINGS, ONTOLOGY_RELATIONSHIPS } from './ontologyCatalogRelations';

/**
 * Phase C knowledge graph: the small query/retrieval abstraction over the
 * canonical ontology. Future Phase D/E systems ask THIS layer — never raw
 * arrays — "what knowledge entities are associated with this problem?".
 *
 * Guarantees:
 * - Construction validates the catalog and throws on duplicates, unknown
 *   types, dangling relationship endpoints, or inconsistent mappings, so a
 *   broken catalog fails fast in development, never silently in production.
 * - Queries are lenient: unknown IDs yield empty results (never throws),
 *   because classification and retrieval must degrade gracefully.
 * - Many-to-many is structural: no entity has a single-parent field; every
 *   hierarchy-like question is answered by traversing relationship records.
 */

export interface RelatedEntity {
  entity: KnowledgeEntity;
  /** The relationship as stored (`fromId -type-> toId`). */
  relationship: KnowledgeRelationship;
  /** True when the queried entity is the `fromId` side. */
  outgoing: boolean;
}

function requireNonBlank(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid knowledge catalog: ${what} must be a non-blank string.`);
  }
  return value;
}

export class KnowledgeGraph {
  private readonly entities = new Map<string, KnowledgeEntity>();
  private readonly relationships: KnowledgeRelationship[] = [];
  private readonly mappings: CurriculumSourceMapping[] = [];
  private readonly aliasIndex = new Map<string, string>();
  private readonly nameIndex = new Map<string, string>();

  constructor(
    entities: KnowledgeEntity[],
    relationships: KnowledgeRelationship[],
    mappings: CurriculumSourceMapping[],
  ) {
    for (const entity of entities) {
      const id = requireNonBlank(entity.id, 'entity.id');
      if (this.entities.has(id)) {
        throw new Error(`Invalid knowledge catalog: duplicate entity id "${id}".`);
      }
      if (!isKnownKnowledgeEntityType(entity.type)) {
        throw new Error(`Invalid knowledge catalog: entity "${id}" has unknown type.`);
      }
      requireNonBlank(entity.name, `entity "${id}".name`);
      requireNonBlank(entity.description, `entity "${id}".description`);
      const layer = entity.layer ?? 'dsa';
      if (layer !== 'dsa' && layer !== 'tooling') {
        throw new Error(`Invalid knowledge catalog: entity "${id}" has unknown layer.`);
      }
      this.entities.set(id, { ...entity, layer });
      const normalizedName = normalizeKnowledgeName(entity.name);
      if (normalizedName.length > 0 && !this.nameIndex.has(normalizedName)) {
        this.nameIndex.set(normalizedName, id);
      }
      const aliases = entity.aliases ?? [];
      if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string')) {
        throw new Error(`Invalid knowledge catalog: entity "${id}" has malformed aliases.`);
      }
      for (const alias of aliases) {
        const key = normalizeKnowledgeName(alias);
        if (key.length === 0) {
          continue;
        }
        const claimedBy = this.aliasIndex.get(key);
        if (claimedBy !== undefined && claimedBy !== id) {
          throw new Error(
            `Invalid knowledge catalog: alias "${alias}" claimed by both "${claimedBy}" and "${id}". ` +
              'Aliases must resolve to exactly one canonical entity.',
          );
        }
        this.aliasIndex.set(key, id);
      }
    }
    for (const rel of relationships) {
      if (!isKnownKnowledgeRelationshipType(rel.type)) {
        throw new Error('Invalid knowledge catalog: relationship has unknown type.');
      }
      if (!this.entities.has(rel.fromId)) {
        throw new Error(`Invalid knowledge catalog: relationship from unknown entity "${rel.fromId}".`);
      }
      if (!this.entities.has(rel.toId)) {
        throw new Error(`Invalid knowledge catalog: relationship to unknown entity "${rel.toId}".`);
      }
      if (rel.fromId === rel.toId) {
        throw new Error(`Invalid knowledge catalog: self-relationship on "${rel.fromId}".`);
      }
      this.relationships.push({ ...rel });
    }
    const mappingIds = new Set<string>();
    for (const mapping of mappings) {
      const mappingId = requireNonBlank(mapping.mappingId, 'curriculum mapping.mappingId');
      if (mappingIds.has(mappingId)) {
        throw new Error(`Invalid knowledge catalog: duplicate curriculum mapping id "${mappingId}".`);
      }
      mappingIds.add(mappingId);
      requireNonBlank(mapping.source, `curriculum mapping "${mappingId}".source`);
      requireNonBlank(mapping.sourceCategory, `curriculum mapping "${mappingId}".sourceCategory`);
      requireNonBlank(mapping.sourceItem, `curriculum mapping "${mappingId}".sourceItem`);
      if (mapping.status !== 'mapped' && mapping.status !== 'unknown') {
        throw new Error(`Invalid knowledge catalog: curriculum mapping "${mappingId}" has unknown status.`);
      }
      if (mapping.status === 'mapped') {
        if (mapping.entityId === null || !this.entities.has(mapping.entityId)) {
          throw new Error(
            `Invalid knowledge catalog: curriculum mapping "${mappingId}" is "mapped" but has no known entityId.`,
          );
        }
      } else if (mapping.entityId !== null) {
        throw new Error(
          `Invalid knowledge catalog: curriculum mapping "${mappingId}" is "unknown" but carries an entityId. ` +
            'Unknown items must not invent a canonical meaning.',
        );
      }
      this.mappings.push({ ...mapping });
    }
    void KNOWLEDGE_RELATIONSHIP_TYPES;
  }

  get ontologyVersion(): string {
    return ONTOLOGY_VERSION;
  }

  entityCount(): number {
    return this.entities.size;
  }

  relationshipCount(): number {
    return this.relationships.length;
  }

  mappingCount(): number {
    return this.mappings.length;
  }

  hasEntity(id: string): boolean {
    return this.entities.has(id);
  }

  getEntity(id: string): KnowledgeEntity | null {
    return this.entities.get(id) ?? null;
  }

  listEntities(type?: KnowledgeEntityType): KnowledgeEntity[] {
    const all = [...this.entities.values()];
    if (type === undefined) {
      return all.sort((a, b) => a.id.localeCompare(b.id));
    }
    return all.filter((e) => e.type === type).sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Case/punctuation-insensitive exact match on the canonical display name. */
  findByName(name: string): KnowledgeEntity | null {
    const id = this.nameIndex.get(normalizeKnowledgeName(name));
    return id !== undefined ? this.entities.get(id) ?? null : null;
  }

  /**
   * Resolve source terminology to its canonical entity. Checks declared
   * aliases first, then falls back to an exact normalized-name match, so
   * "Multi Source BFS" and "Multi-source BFS" land on the same entity
   * without duplicate canonical records.
   */
  findByAlias(alias: string): KnowledgeEntity | null {
    const key = normalizeKnowledgeName(alias);
    if (key.length === 0) {
      return null;
    }
    const byAlias = this.aliasIndex.get(key);
    if (byAlias !== undefined) {
      return this.entities.get(byAlias) ?? null;
    }
    return this.findByName(alias);
  }

  /**
   * Every relationship touching `id`, either direction. Optional `types`
   * narrows the vocabulary. Unknown IDs yield [] (lenient query).
   */
  getRelatedEntities(id: string, types?: readonly KnowledgeRelationshipType[]): RelatedEntity[] {
    if (!this.entities.has(id)) {
      return [];
    }
    const wanted = types !== undefined ? new Set<string>(types) : null;
    const out: RelatedEntity[] = [];
    for (const relationship of this.relationships) {
      if (wanted !== null && !wanted.has(relationship.type)) {
        continue;
      }
      if (relationship.fromId === id) {
        const entity = this.entities.get(relationship.toId);
        if (entity) {
          out.push({ entity, relationship, outgoing: true });
        }
      } else if (relationship.toId === id) {
        const entity = this.entities.get(relationship.fromId);
        if (entity) {
          out.push({ entity, relationship, outgoing: false });
        }
      }
    }
    return out.sort((a, b) => a.entity.id.localeCompare(b.entity.id));
  }

  /** Entities presented under `id` (topic-style children), either edge direction. */
  getChildren(id: string): KnowledgeEntity[] {
    return this.getRelatedEntities(id)
      .filter(
        (r) =>
          (r.outgoing && r.relationship.type === 'parent_of') ||
          (!r.outgoing && r.relationship.type === 'child_of'),
      )
      .map((r) => r.entity);
  }

  /** Entities presenting `id` (topic-style parents), either edge direction. */
  getParents(id: string): KnowledgeEntity[] {
    return this.getRelatedEntities(id)
      .filter(
        (r) =>
          (!r.outgoing && r.relationship.type === 'parent_of') ||
          (r.outgoing && r.relationship.type === 'child_of'),
      )
      .map((r) => r.entity);
  }

  /**
   * Structural forms and specializations of `id`: explicit `form_of` /
   * `variant_of` edges plus hierarchy-presented members typed form/variant.
   */
  getFormsAndVariants(id: string): KnowledgeEntity[] {
    const seen = new Map<string, KnowledgeEntity>();
    for (const r of this.getRelatedEntities(id)) {
      const isFormEdge =
        !r.outgoing && (r.relationship.type === 'form_of' || r.relationship.type === 'variant_of');
      const isPresentedFormOrVariant =
        r.outgoing &&
        r.relationship.type === 'parent_of' &&
        (r.entity.type === 'form' || r.entity.type === 'variant');
      if (isFormEdge || isPresentedFormOrVariant) {
        seen.set(r.entity.id, r.entity);
      }
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Learning dependencies of `id`: X where X —prerequisite_of→ id. */
  getPrerequisites(id: string): KnowledgeEntity[] {
    return this.getRelatedEntities(id, ['prerequisite_of'])
      .filter((r) => !r.outgoing)
      .map((r) => r.entity);
  }

  /** Curriculum mappings pointing at `entityId` (canonical → source direction). */
  getCurriculumMappings(entityId: string): CurriculumSourceMapping[] {
    return this.mappings
      .filter((m) => m.entityId === entityId)
      .sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  }

  /** Source items preserved WITHOUT a canonical meaning (never hallucinated). */
  getUnknownMappings(): CurriculumSourceMapping[] {
    return this.mappings
      .filter((m) => m.status === 'unknown')
      .sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  }

  /** All mappings for one curriculum source, optionally narrowed to a category. */
  getMappingsForSource(source: string, sourceCategory?: string): CurriculumSourceMapping[] {
    return this.mappings
      .filter(
        (m) =>
          m.source === source && (sourceCategory === undefined || m.sourceCategory === sourceCategory),
      )
      .sort((a, b) => a.mappingId.localeCompare(b.mappingId));
  }
}

export function createKnowledgeGraph(
  entities: KnowledgeEntity[] = ONTOLOGY_ENTITIES,
  relationships: KnowledgeRelationship[] = ONTOLOGY_RELATIONSHIPS,
  mappings: CurriculumSourceMapping[] = ONTOLOGY_CURRICULUM_MAPPINGS,
): KnowledgeGraph {
  return new KnowledgeGraph(entities, relationships, mappings);
}

let defaultGraph: KnowledgeGraph | null = null;

/**
 * The bundled canonical ontology (versioned via `ONTOLOGY_VERSION`).
 * Built once and shared; classification records stamp this version so
 * future ontology evolution can trigger reclassification explicitly.
 */
export function getDefaultKnowledgeGraph(): KnowledgeGraph {
  if (!defaultGraph) {
    defaultGraph = createKnowledgeGraph();
  }
  return defaultGraph;
}
