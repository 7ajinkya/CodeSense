import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CLASSIFICATION_CONFIDENCES,
  ONTOLOGY_VERSION,
  isKnownClassificationConfidence,
  normalizeKnowledgeName,
} from 'codesense/knowledge/ontologyTypes';
import {
  createKnowledgeGraph,
  getDefaultKnowledgeGraph,
} from 'codesense/knowledge/ontologyStore';
import {
  CLASSIFIER_VERSION,
  FORBIDDEN_CLASSIFICATION_KEYS,
  attachClassificationToProblem,
  finalizeClassification,
  getClassificationStatus,
  parseProblemClassification,
  resolveProblemKnowledge,
  validateClassificationPayload,
} from 'codesense/knowledge/classification';
import { LocalClassificationStore } from 'codesense/knowledge/classificationStore';
import {
  CLASSIFICATION_PROMPT_VERSION,
  CLASSIFICATION_SYSTEM_PROMPT,
  renderEntityReference,
  renderProblemForClassification,
} from 'codesense/knowledge/classifierPrompt';
import {
  ClassificationPorts,
  FakeProblemClassificationReasoner,
  HttpProblemClassificationReasoner,
  buildClassificationInput,
  buildClassificationRequest,
  runProblemClassification,
} from 'codesense/knowledge/classifier';
import {
  Problem,
  createManualProblem,
  isUsableProblem,
} from 'codesense/problems/problem';
import { LocalProblemStore } from 'codesense/problems/problemStore';
import { buildAIContext } from 'codesense/context/aiContext';
import { renderClassificationForPrompt, renderContextForPrompt } from 'codesense/ai/aiPrompt';
import { createAttempt } from 'codesense/attempts/attempt';

/**
 * Phase C — Knowledge Graph & Problem Classification.
 *
 * Machine-enforced properties live here: the data-driven canonical
 * ontology, strict classification validation (including the Phase C/D
 * separation that rejects learner-model keys), versioned provenance,
 * automatic (never manual) classification, graceful failure, and the
 * retrieval layer future phases will query.
 */

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), name);
}

function clean(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
}

function rottingOranges(): Problem {
  return createManualProblem('https://leetcode.com/problems/rotting-oranges/', {
    title: 'Rotting Oranges',
    statement: 'You are given an m x n grid where each cell can have values 0 (empty), 1 (fresh orange), or 2 (rotten orange). Every minute, any fresh orange adjacent to a rotten orange becomes rotten. Return the minimum minutes until no fresh orange remains.',
    constraints: 'm == grid.length, n == grid[i].length, 1 <= m, n <= 10',
  });
}

function scriptedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topics: [{ entityId: 'topic.graphs', confidence: 'high' }],
    concepts: [{ entityId: 'concept.connected-components', confidence: 'medium' }],
    frameworks: [{ entityId: 'framework.bfs', confidence: 'high' }],
    forms: [{ entityId: 'form.multisource-bfs', confidence: 'medium' }],
    patterns: [{ entityId: 'pattern.distance-time-propagation', confidence: 'medium' }],
    variants: [],
    tactics: [{ entityId: 'tactic.visited-on-enqueue', confidence: 'high' }],
    prerequisites: [{ entityId: 'concept.queue-fifo', confidence: 'high' }],
    solutionFamilies: [{ entityId: 'framework.bfs', confidence: 'high' }],
    curriculumMappings: [
      {
        source: 'AlgoZenith',
        sourceCategory: 'Graph Level 1',
        sourceItem: 'Multisource BFS',
        entityId: 'form.multisource-bfs',
        status: 'mapped',
        confidence: 'high',
      },
    ],
    confidence: 'high',
    ...overrides,
  };
}

function stamped(extraStamped: Record<string, string> = {}) {
  const graph = getDefaultKnowledgeGraph();
  const validated = validateClassificationPayload(scriptedPayload(), { graph });
  if (!validated.ok) {
    throw new Error('scripted payload must validate');
  }
  const problem = rottingOranges();
  return finalizeClassification(validated.value, {
    problemId: problem.problemId,
    ontologyVersion: graph.ontologyVersion,
    classifierVersion: CLASSIFIER_VERSION,
    classifiedAt: '2026-01-01T00:00:00.000Z',
    problemSourceUrl: problem.provenance.sourceUrl,
    source: 'ai',
    ...extraStamped,
  });
}

// ---------------------------------------------------------------------------
// ONTOLOGY: loading, stable IDs, data-driven growth
// ---------------------------------------------------------------------------

describe('Phase C ontology (canonical, data-driven)', () => {
  it('loads a versioned catalog broad enough for the supplied curricula', () => {
    const graph = getDefaultKnowledgeGraph();
    expect(graph.ontologyVersion).to.equal(ONTOLOGY_VERSION);
    expect(ONTOLOGY_VERSION).to.equal('1');
    expect(graph.entityCount()).to.be.greaterThan(100);
    expect(graph.relationshipCount()).to.be.greaterThan(100);
    expect(graph.mappingCount()).to.be.greaterThan(50);
    // Every conceptual entity type is populated (no empty vocabulary slot).
    for (const type of ['topic', 'concept', 'framework', 'form', 'pattern', 'variant', 'tactic'] as const) {
      expect(graph.listEntities(type).length, type).to.be.greaterThan(0);
    }
  });

  it('exposes stable IDs for the required knowledge areas', () => {
    const graph = getDefaultKnowledgeGraph();
    for (const id of [
      'topic.graphs',
      'topic.dynamic-programming',
      'topic.binary-search',
      'topic.prefix-sums',
      'topic.trees',
      'topic.range-structures',
      'framework.bfs',
      'framework.dijkstra',
      'framework.bellman-ford',
      'framework.floyd-warshall',
      'form.multisource-bfs',
      'form.knapsack-01',
      'form.bitmask-dp',
      'form.digit-dp',
      'form.tree-dp',
      'form.search-on-answer',
      'framework.kmp',
      'framework.z-algorithm',
      'framework.manacher',
      'variant.bit-trie',
      'framework.fenwick-tree',
      'framework.segment-tree',
    ]) {
      expect(graph.hasEntity(id), id).to.be.true;
      expect(graph.getEntity(id)!.id).to.equal(id);
    }
    expect(graph.getEntity('nope.unknown')).to.be.null;
    expect(graph.hasEntity('nope.unknown')).to.be.false;
  });

  it('grows by data, not by architecture (no enum/switch to extend)', () => {
    const graph = createKnowledgeGraph(
      [
        { id: 'topic.custom', type: 'topic', name: 'Custom', description: 'Custom topic.' },
        { id: 'framework.custom-fw', type: 'framework', name: 'Custom FW', description: 'Custom framework.' },
      ],
      [{ fromId: 'topic.custom', type: 'parent_of', toId: 'framework.custom-fw' }],
      [],
    );
    expect(graph.getEntity('framework.custom-fw')!.name).to.equal('Custom FW');
    expect(graph.getChildren('topic.custom').map((e) => e.id)).to.deep.equal(['framework.custom-fw']);
  });

  it('rejects broken catalogs fast (duplicates, dangling refs, bad mappings)', () => {
    const entity = { id: 'topic.a', type: 'topic' as const, name: 'A', description: 'A.' };
    expect(() => createKnowledgeGraph([entity, { ...entity }], [], [])).to.throw(/duplicate entity/);
    expect(() =>
      createKnowledgeGraph([entity], [{ fromId: 'topic.a', type: 'parent_of', toId: 'missing' }], []),
    ).to.throw(/unknown entity/);
    expect(() =>
      createKnowledgeGraph(
        [entity],
        [],
        [{ mappingId: 'm1', source: 'S', sourceCategory: 'C', sourceItem: 'I', entityId: 'missing', status: 'mapped' }],
      ),
    ).to.throw(/no known entityId/);
    expect(() =>
      createKnowledgeGraph(
        [entity],
        [],
        [{ mappingId: 'm1', source: 'S', sourceCategory: 'C', sourceItem: 'Form 9', entityId: 'topic.a', status: 'unknown' }],
      ),
    ).to.throw(/must not invent/);
    const aliased = { id: 'framework.x', type: 'framework' as const, name: 'X Why', description: 'X.', aliases: ['Same Alias'] };
    const aliased2 = { id: 'framework.y', type: 'framework' as const, name: 'Y Why', description: 'Y.', aliases: ['same  alias'] };
    expect(() => createKnowledgeGraph([aliased, aliased2], [], [])).to.throw(/exactly one canonical entity/);
  });
});

// ---------------------------------------------------------------------------
// ONTOLOGY: aliases (no duplicate canonical entities)
// ---------------------------------------------------------------------------

describe('Phase C aliases', () => {
  it('resolves source-terminology variants to one canonical entity', () => {
    const graph = getDefaultKnowledgeGraph();
    const canonical = graph.getEntity('form.multisource-bfs')!;
    for (const alias of ['Multi-source BFS', 'Multi Source BFS', 'Multiple Source BFS', 'multisource  bfs']) {
      expect(graph.findByAlias(alias)?.id, alias).to.equal(canonical.id);
    }
    expect(graph.findByAlias('Union Find')?.id).to.equal('framework.dsu');
    expect(graph.findByAlias('DSU')?.id).to.equal('framework.dsu');
    expect(graph.findByAlias('BIT')?.id).to.equal('framework.fenwick-tree');
    expect(graph.findByAlias('lowest common ancestor')?.id).to.equal('form.lca-binary-lifting');
  });

  it('finds canonical names and returns null for unknown terminology', () => {
    const graph = getDefaultKnowledgeGraph();
    expect(graph.findByName('BFS')?.id).to.equal('framework.bfs');
    expect(graph.findByName('  bfs  ')?.id).to.equal('framework.bfs');
    expect(graph.findByAlias('Form 2')).to.be.null;
    expect(graph.findByAlias('')).to.be.null;
    expect(graph.findByAlias('KWALK')).to.be.null;
    expect(normalizeKnowledgeName('Multi-Source_BFS')).to.equal('multi source bfs');
  });
});

// ---------------------------------------------------------------------------
// ONTOLOGY: graph relationships (many-to-many, not a rigid tree)
// ---------------------------------------------------------------------------

describe('Phase C graph relationships', () => {
  it('supports many-to-many presentation (BFS has several parents)', () => {
    const graph = getDefaultKnowledgeGraph();
    const parents = graph.getParents('framework.bfs').map((e) => e.id);
    expect(parents).to.include('topic.graphs');
    expect(parents).to.include('topic.trees');
    const children = graph.getChildren('topic.graphs').map((e) => e.id);
    expect(children).to.include('framework.bfs');
    expect(children).to.include('framework.dijkstra');
  });

  it('exposes forms, variants, prerequisites, and cross-links', () => {
    const graph = getDefaultKnowledgeGraph();
    const bfsForms = graph.getFormsAndVariants('framework.bfs').map((e) => e.id);
    expect(bfsForms).to.include('form.grid-bfs');
    expect(bfsForms).to.include('form.multisource-bfs');
    expect(bfsForms).to.include('form.state-space-bfs');
    // One entity, several meaningful relationships (graph, not tree).
    const bfsRelated = graph.getRelatedEntities('framework.bfs');
    const types = new Set(bfsRelated.map((r) => r.relationship.type));
    expect(types.size).to.be.greaterThan(2);
    expect(bfsRelated.some((r) => r.relationship.type === 'uses' && r.entity.id === 'concept.queue-fifo')).to.be.true;
    expect(bfsRelated.some((r) => r.relationship.type === 'related_to' && r.entity.id === 'framework.dijkstra')).to.be.true;
    // Prerequisites are learning dependencies, queried directionally.
    expect(graph.getPrerequisites('framework.dijkstra').map((e) => e.id)).to.include('framework.bfs');
    expect(graph.getPrerequisites('form.search-on-answer').map((e) => e.id)).to.include('concept.monotonicity');
    // A form can specialize two frameworks (many-to-many on the edge too).
    const coloring = graph.getRelatedEntities('form.bipartite-coloring', ['form_of']);
    expect(coloring.map((r) => r.entity.id).sort()).to.deep.equal(['framework.bfs', 'framework.dfs']);
  });

  it('keeps implementation knowledge in a separate tooling layer', () => {
    const graph = getDefaultKnowledgeGraph();
    const dsaTopics = graph.listEntities('topic');
    expect(dsaTopics.every((e) => (e.layer ?? 'dsa') === 'dsa')).to.be.true;
    const stl = graph.getEntity('capability.cpp-stl-containers')!;
    expect(stl.layer).to.equal('tooling');
    expect(stl.type).to.equal('capability');
    // Tooling capabilities are referenceable as relevant problem knowledge…
    const validated = validateClassificationPayload(
      scriptedPayload({ tactics: [{ entityId: 'capability.language-collections-api', confidence: 'medium' }] }),
      { graph },
    );
    expect(validated.ok).to.be.true;
    // …but never smuggled into the DSA topic hierarchy.
    expect(graph.getChildren('topic.graphs').some((e) => e.type === 'capability')).to.be.false;
  });

  it('answers lenient queries with empty results instead of throwing', () => {
    const graph = getDefaultKnowledgeGraph();
    expect(graph.getRelatedEntities('missing.id')).to.deep.equal([]);
    expect(graph.getChildren('missing.id')).to.deep.equal([]);
    expect(graph.getFormsAndVariants('missing.id')).to.deep.equal([]);
    expect(graph.getPrerequisites('missing.id')).to.deep.equal([]);
    expect(graph.getCurriculumMappings('missing.id')).to.deep.equal([]);
  });
});

// ---------------------------------------------------------------------------
// ONTOLOGY: curriculum mappings + unknown material
// ---------------------------------------------------------------------------

describe('Phase C curriculum mappings', () => {
  it('keeps source organization separate from canonical knowledge', () => {
    const graph = getDefaultKnowledgeGraph();
    const mappings = graph.getCurriculumMappings('form.multisource-bfs');
    expect(mappings.length).to.be.greaterThan(0);
    const az = mappings.find((m) => m.source === 'AlgoZenith' && m.sourceCategory === 'Graph Level 1');
    expect(az).to.not.be.undefined;
    expect(az!.sourceItem).to.equal('Multisource BFS');
    expect(az!.status).to.equal('mapped');
    // Source labels are provenance, not canonical names.
    expect(az!.sourceItem).to.not.equal(graph.getEntity('form.multisource-bfs')!.id);
    // Scoped source queries work without flattening.
    const graphL1 = graph.getMappingsForSource('AlgoZenith', 'Graph Level 1');
    expect(graphL1.length).to.be.greaterThan(0);
    expect(graphL1.every((m) => m.sourceCategory === 'Graph Level 1')).to.be.true;
    expect(graph.getMappingsForSource('Nope University')).to.deep.equal([]);
  });

  it('lets one canonical entity appear across curriculum categories', () => {
    const graph = getDefaultKnowledgeGraph();
    const forTrie = graph.getCurriculumMappings('variant.bit-trie');
    expect(forTrie.length).to.be.greaterThan(1);
    // Architecture-level proof with two sources on a synthetic graph.
    const custom = createKnowledgeGraph(
      [{ id: 'framework.x', type: 'framework', name: 'X', description: 'X.' }],
      [],
      [
        { mappingId: 's1', source: 'SourceA', sourceCategory: 'Cat 1', sourceItem: 'X form', entityId: 'framework.x', status: 'mapped' },
        { mappingId: 's2', source: 'SourceB', sourceCategory: 'Other', sourceItem: 'X-technique', entityId: 'framework.x', status: 'mapped' },
      ],
    );
    expect(custom.getCurriculumMappings('framework.x').map((m) => m.source).sort()).to.deep.equal(['SourceA', 'SourceB']);
  });

  it('preserves unknown/unmapped material without inventing meanings', () => {
    const graph = getDefaultKnowledgeGraph();
    const unknown = graph.getUnknownMappings();
    expect(unknown.length).to.be.greaterThan(4);
    for (const item of unknown) {
      expect(item.status).to.equal('unknown');
      expect(item.entityId).to.be.null;
      expect(item.sourceItem.trim().length).to.be.greaterThan(0);
    }
    const labels = unknown.map((m) => m.sourceItem);
    expect(labels).to.include('KWALK');
    expect(labels).to.include('Form 2 - Beyond Basic Knapsack');
    expect(labels).to.include('Hard Problem');
    // Unknowns never resolve to entities through any lookup.
    expect(graph.findByAlias('KWALK')).to.be.null;
  });
});

// ---------------------------------------------------------------------------
// CLASSIFICATION: strict validation
// ---------------------------------------------------------------------------

describe('Phase C classification validation', () => {
  it('accepts a complete valid classification and stamps versions', () => {
    const graph = getDefaultKnowledgeGraph();
    const validated = validateClassificationPayload(scriptedPayload(), { graph });
    expect(validated.ok).to.be.true;
    if (!validated.ok) {
      return;
    }
    const problem = rottingOranges();
    const classification = finalizeClassification(validated.value, {
      problemId: problem.problemId,
      ontologyVersion: graph.ontologyVersion,
      classifierVersion: CLASSIFIER_VERSION,
      classifiedAt: '2026-01-01T00:00:00.000Z',
      problemSourceUrl: problem.provenance.sourceUrl,
      source: 'ai',
    });
    expect(classification.problemId).to.equal(problem.problemId);
    expect(classification.ontologyVersion).to.equal(ONTOLOGY_VERSION);
    expect(classification.classifierVersion).to.equal(CLASSIFIER_VERSION);
    expect(classification.classifiedAt).to.equal('2026-01-01T00:00:00.000Z');
    expect(classification.confidence).to.equal('high');
    expect(classification.frameworks[0]).to.deep.equal({ entityId: 'framework.bfs', confidence: 'high' });
    expect(classification.provenance).to.deep.equal({
      source: 'ai',
      classifierVersion: CLASSIFIER_VERSION,
      ontologyVersion: ONTOLOGY_VERSION,
      classifiedAt: '2026-01-01T00:00:00.000Z',
      problemSourceUrl: problem.provenance.sourceUrl,
    });
    // Stable IDs, not display names, are referenced.
    expect(classification.frameworks[0].entityId).to.not.equal('BFS');
  });

  it('accepts sparse payloads (omitted buckets mean no claim, not failure)', () => {
    const graph = getDefaultKnowledgeGraph();
    const validated = validateClassificationPayload({ confidence: 'low' }, { graph });
    expect(validated.ok).to.be.true;
    if (!validated.ok) {
      return;
    }
    expect(validated.value.topics).to.deep.equal([]);
    expect(getClassificationStatus(
      finalizeClassification(validated.value, {
        problemId: 'prob_x',
        ontologyVersion: '1',
        classifierVersion: '1',
        classifiedAt: '2026-01-01T00:00:00.000Z',
        problemSourceUrl: 'https://example.com/x',
        source: 'ai',
      }),
    )).to.equal('partial');
  });

  it('rejects malformed classification output', () => {
    const graph = getDefaultKnowledgeGraph();
    const bad: unknown[] = [
      null,
      'just text',
      42,
      [],
      {},
      scriptedPayload({ confidence: 'extreme' }),
      scriptedPayload({ confidence: 0.9 }),
      scriptedPayload({ confidence: null }),
      scriptedPayload({ topics: 'graphs' }),
      scriptedPayload({ topics: [{ confidence: 'high' }] }),
      scriptedPayload({ topics: [{ entityId: '', confidence: 'high' }] }),
      scriptedPayload({ topics: [{ entityId: 'topic.graphs', confidence: 'extreme' }] }),
      scriptedPayload({
        topics: [
          { entityId: 'topic.graphs', confidence: 'high' },
          { entityId: 'topic.graphs', confidence: 'low' },
        ],
      }),
      scriptedPayload({ curriculumMappings: [{ source: 'AlgoZenith' }] }),
      scriptedPayload({
        curriculumMappings: [{ source: 'S', sourceItem: 'I', status: 'bogus', entityId: null, confidence: null }],
      }),
      scriptedPayload({
        curriculumMappings: [{ source: 'S', sourceItem: 'Form 9', status: 'unknown', entityId: 'topic.graphs', confidence: null }],
      }),
    ];
    for (const raw of bad) {
      const result = validateClassificationPayload(raw, { graph });
      expect(result.ok, JSON.stringify(raw)).to.be.false;
    }
    expect(isKnownClassificationConfidence('high')).to.be.true;
    expect(isKnownClassificationConfidence('medium')).to.be.true;
    expect(isKnownClassificationConfidence('low')).to.be.true;
    expect(isKnownClassificationConfidence('extreme')).to.be.false;
    expect(CLASSIFICATION_CONFIDENCES).to.deep.equal(['high', 'medium', 'low']);
  });

  it('rejects invalid entity references without persisting them', () => {
    const graph = getDefaultKnowledgeGraph();
    const unknownId = validateClassificationPayload(
      scriptedPayload({ frameworks: [{ entityId: 'framework.teleportation', confidence: 'high' }] }),
      { graph },
    );
    expect(unknownId.ok).to.be.false;
    if (!unknownId.ok) {
      expect(unknownId.reason).to.equal('invalid-entity');
    }
    const wrongBucket = validateClassificationPayload(
      scriptedPayload({ topics: [{ entityId: 'framework.bfs', confidence: 'high' }] }),
      { graph },
    );
    expect(wrongBucket.ok).to.be.false;
    const badMapping = validateClassificationPayload(
      scriptedPayload({
        curriculumMappings: [{ source: 'S', sourceItem: 'X', status: 'mapped', entityId: 'nope.no', confidence: null }],
      }),
      { graph },
    );
    expect(badMapping.ok).to.be.false;
    if (!badMapping.ok) {
      expect(badMapping.reason).to.equal('invalid-entity');
    }
  });

  it('ignores unknown non-learner keys (forward-compatible, still strict)', () => {
    const graph = getDefaultKnowledgeGraph();
    const result = validateClassificationPayload(
      scriptedPayload({ classifierNote: 'looks like BFS to me' }),
      { graph },
    );
    expect(result.ok).to.be.true;
  });
});

// ---------------------------------------------------------------------------
// SEPARATION: classification is never a learner model (rejected, not stored)
// ---------------------------------------------------------------------------

describe('Phase C/D separation (no learner model in classification)', () => {
  it('rejects every learner-model key in classification output', () => {
    const graph = getDefaultKnowledgeGraph();
    expect(FORBIDDEN_CLASSIFICATION_KEYS.length).to.be.greaterThan(5);
    for (const key of ['mastery', 'proficiency', 'weakness', 'weaknesses', 'strengths', 'learnerModel', 'learnerTactics', 'debuggingBehavior', 'usedTactics', 'misconceptions']) {
      expect(FORBIDDEN_CLASSIFICATION_KEYS, key).to.include(key);
      const result = validateClassificationPayload(scriptedPayload({ [key]: 'something' }), { graph });
      expect(result.ok, key).to.be.false;
    }
  });

  it('keeps tactic relevance problem-side (no usage claims anywhere)', () => {
    const classification = stamped();
    const asJson = JSON.stringify(classification);
    for (const key of ['mastery', 'weakness', 'proficiency', 'learnerModel', 'debuggingBehavior', 'usedTactics']) {
      expect(asJson, key).to.not.contain(key);
    }
    // Tactics are relevant-technique refs (entity + confidence only)…
    expect(classification.tactics[0]).to.deep.equal({ entityId: 'tactic.visited-on-enqueue', confidence: 'high' });
    const resolved = resolveProblemKnowledge(getDefaultKnowledgeGraph(), classification)!;
    expect(JSON.stringify(resolved)).to.not.contain('mastery');
    expect(JSON.stringify(resolved)).to.not.contain('weakness');
  });
});

// ---------------------------------------------------------------------------
// PROBLEM: store/retrieve, non-mutation, backward compatibility
// ---------------------------------------------------------------------------

describe('Phase C problem integration', () => {
  it('stores and retrieves a classification without touching problem data', () => {
    const problem = rottingOranges();
    const before = JSON.parse(JSON.stringify(problem)) as Problem;
    const classification = stamped({ problemId: problem.problemId });
    const attached = attachClassificationToProblem(problem, classification);
    // Only the classification field is added; everything else is identical.
    const { classification: _dropped, ...attachedRest } = attached;
    expect(_dropped).to.deep.equal(classification);
    expect(attachedRest).to.deep.equal(before);
    // Original object is not mutated by the attach helper.
    expect(problem.classification).to.be.undefined;
    expect(() => attachClassificationToProblem(problem, { ...classification, problemId: 'prob_other' })).to.throw(/Cannot attach/);
  });

  it('persists classifications per problem with history preserved', async () => {
    const dir = tmpDir('codesense-test-phase-c-classifications');
    clean(dir);
    try {
      const store = new LocalClassificationStore(dir);
      expect(await store.getClassification('prob_missing')).to.be.null;
      expect(await store.listClassifications()).to.deep.equal([]);
      const problem = rottingOranges();
      const first = stamped({ problemId: problem.problemId });
      await store.saveClassification(first);
      expect(await store.getClassification(problem.problemId)).to.deep.equal(first);
      const second = { ...stamped({ problemId: problem.problemId }), classifiedAt: '2026-02-01T00:00:00.000Z' };
      await store.saveClassification(second);
      // Latest wins for reads; the earlier record's provenance survives on disk.
      expect(await store.getClassification(problem.problemId)).to.deep.equal(second);
      expect(await store.listClassifications()).to.have.lengthOf(1);
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.codesense', 'classifications.json'), 'utf-8')) as unknown[];
      expect(onDisk.filter((r) => (r as { problemId: string }).problemId === problem.problemId)).to.have.lengthOf(2);
      let threw = false;
      try {
        await store.saveClassification({ nope: true } as unknown as never);
      } catch {
        threw = true;
      }
      expect(threw, 'malformed classification must not persist').to.be.true;
    } finally {
      clean(dir);
    }
  });

  it('round-trips classifications through parse (versions preserved)', () => {
    const classification = stamped();
    const parsed = parseProblemClassification(JSON.parse(JSON.stringify(classification)) as unknown);
    expect(parsed).to.deep.equal(classification);
    // Historical versions still load (lenient, graph-agnostic).
    const legacy = { ...classification, ontologyVersion: '0', classifierVersion: '0' };
    expect(parseProblemClassification(legacy)?.ontologyVersion).to.equal('0');
    for (const bad of [null, {}, { ...classification, confidence: 'extreme' }, { ...classification, topics: 'x' }, { ...classification, provenance: null }]) {
      expect(parseProblemClassification(bad)).to.be.null;
    }
  });

  it('keeps unclassified problems fully usable', () => {
    const problem = rottingOranges();
    expect(problem.classification ?? null).to.be.null;
    expect(getClassificationStatus(problem.classification)).to.equal('unclassified');
    expect(getClassificationStatus(null)).to.equal('unclassified');
    expect(isUsableProblem(problem)).to.be.true;
    expect(getClassificationStatus(stamped())).to.equal('classified');
    expect(resolveProblemKnowledge(getDefaultKnowledgeGraph(), null)).to.be.null;
  });

  it('loads pre-Phase-C problems (no classification field) unchanged', async () => {
    const dir = tmpDir('codesense-test-phase-c-legacy');
    clean(dir);
    try {
      const store = new LocalProblemStore(dir);
      const problem = rottingOranges();
      await store.upsertProblem(problem);
      // Simulate a pre-Phase-C record by stripping the optional field on disk.
      const file = path.join(dir, '.codesense', 'problems.json');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Array<Record<string, unknown>>;
      for (const record of onDisk) {
        delete record.classification;
      }
      fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));
      const reloaded = await store.getProblem(problem.problemId);
      expect(reloaded).to.not.be.null;
      expect(reloaded!.classification ?? null).to.be.null;
      expect(isUsableProblem(reloaded!)).to.be.true;
      expect(reloaded!.title).to.equal(problem.title);
      // A malformed cached classification is dropped, never fatal.
      onDisk[0].classification = { nonsense: true };
      fs.writeFileSync(file, JSON.stringify(onDisk, null, 2));
      const tolerant = await store.getProblem(problem.problemId);
      expect(tolerant).to.not.be.null;
      expect(tolerant!.classification ?? null).to.be.null;
      expect(tolerant!.statement).to.equal(problem.statement);
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// AI: request building, validation, failure handling (no network)
// ---------------------------------------------------------------------------

describe('Phase C AI classifier', () => {
  function ports(overrides: Partial<ClassificationPorts> = {}): ClassificationPorts & { dir: string } {
    const dir = tmpDir(`codesense-test-phase-c-run-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    clean(dir);
    return {
      dir,
      reasoner: new FakeProblemClassificationReasoner([scriptedPayload()]),
      store: new LocalClassificationStore(dir),
      graph: getDefaultKnowledgeGraph(),
      model: 'stub-model',
      nowIso: () => '2026-01-01T00:00:00.000Z',
      timeoutMs: 1000,
      ...overrides,
    };
  }

  it('builds a structured, problem-scoped request reusing the provider layer', () => {
    const graph = getDefaultKnowledgeGraph();
    const input = buildClassificationInput(rottingOranges());
    expect(input.title).to.equal('Rotting Oranges');
    expect(input.provider).to.equal('leetcode');
    // Privacy: the input carries ONLY problem fields — no attempt/workspace keys.
    expect(Object.keys(input).sort()).to.deep.equal(
      ['constraints', 'difficulty', 'examples', 'problemId', 'provider', 'sourceUrl', 'statement', 'title', 'topics'].sort(),
    );
    const request = buildClassificationRequest('stub-model', input, graph);
    expect(request.model).to.equal('stub-model');
    expect(request.response_format).to.deep.equal({ type: 'json_object' });
    const messages = request.messages as Array<{ role: string; content: string }>;
    expect(messages.length).to.equal(2);
    expect(messages[0].role).to.equal('system');
    expect(messages[0].content).to.contain('What knowledge does this problem exercise?');
    expect(messages[0].content).to.contain('NEVER answer');
    expect(messages[0].content).to.contain('form.multisource-bfs');
    expect(messages[0].content).to.contain('Ontology version: 1');
    expect(messages[0].content).to.contain(CLASSIFICATION_SYSTEM_PROMPT);
    expect(messages[1].role).to.equal('user');
    expect(messages[1].content).to.contain('Rotting Oranges');
    expect(messages[1].content).to.contain('rotten orange');
    // The HTTP reasoner shares the single chat-completions transport.
    const http = new HttpProblemClassificationReasoner({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm' });
    expect(http.name).to.equal('http-classification');
  });

  it('bounds classifier problem text no matter the problem size', () => {
    const problem = rottingOranges();
    problem.statement = 'x'.repeat(20000);
    const text = renderProblemForClassification(buildClassificationInput(problem));
    expect(text.length).to.be.lessThan(20000);
    expect(text).to.contain('truncated for prompt budget');
    expect(renderEntityReference(getDefaultKnowledgeGraph())).to.contain('frameworks:');
    expect(CLASSIFICATION_PROMPT_VERSION).to.equal(1);
  });

  it('classifies end-to-end and persists without mutating the problem', async () => {
    const p = ports();
    try {
      const problem = rottingOranges();
      const snapshot = JSON.stringify(problem);
      const outcome = await runProblemClassification(p, problem);
      expect(outcome.status).to.equal('classified');
      if (outcome.status !== 'classified') {
        return;
      }
      expect(outcome.classification.problemId).to.equal(problem.problemId);
      expect(outcome.classification.ontologyVersion).to.equal(ONTOLOGY_VERSION);
      expect(outcome.classification.classifierVersion).to.equal(CLASSIFIER_VERSION);
      expect(outcome.classification.provenance.source).to.equal('ai');
      // The Problem record is untouched by classification.
      expect(JSON.stringify(problem)).to.equal(snapshot);
      // Persisted and retrievable by problemId.
      expect(await p.store.getClassification(problem.problemId)).to.deep.equal(outcome.classification);
      const reasoner = p.reasoner as FakeProblemClassificationReasoner;
      expect(reasoner.seen.length).to.equal(1);
    } finally {
      clean(p.dir);
    }
  });

  it('skips work that is already done or has no content', async () => {
    const p = ports();
    try {
      const problem = rottingOranges();
      await runProblemClassification(p, problem);
      const reasoner = p.reasoner as FakeProblemClassificationReasoner;
      expect(reasoner.seen.length).to.equal(1);
      const again = await runProblemClassification(p, problem);
      expect(again).to.deep.equal({ status: 'skipped', reason: 'already-classified' });
      expect(reasoner.seen.length).to.equal(1);
      const empty = createManualProblem('https://example.com/empty/', { title: '', statement: '' });
      expect(await runProblemClassification(p, empty)).to.deep.equal({ status: 'skipped', reason: 'no-content' });
    } finally {
      clean(p.dir);
    }
  });

  it('reclassifies explicitly after an ontology bump (no silent semantics)', async () => {
    const p = ports();
    try {
      const problem = rottingOranges();
      const legacy = { ...stamped({ problemId: problem.problemId }), ontologyVersion: '0' };
      await p.store.saveClassification(legacy);
      const outcome = await runProblemClassification(p, problem);
      expect(outcome.status).to.equal('classified');
      if (outcome.status !== 'classified') {
        return;
      }
      expect(outcome.classification.ontologyVersion).to.equal(ONTOLOGY_VERSION);
    } finally {
      clean(p.dir);
    }
  });

  it('fails gracefully on provider errors, timeouts, and malformed output', async () => {
    const problem = rottingOranges();
    const failing = await runProblemClassification(
      ports({ reasoner: new FakeProblemClassificationReasoner([new Error('down')]) }),
      problem,
    );
    expect(failing.status).to.equal('failed');
    if (failing.status === 'failed') {
      expect(failing.reason).to.equal('provider-error');
    }
    const hanging = new FakeProblemClassificationReasoner();
    hanging.classify = () => new Promise(() => undefined) as Promise<unknown>;
    const timedOut = await runProblemClassification(ports({ reasoner: hanging, timeoutMs: 20 }), problem);
    expect(timedOut.status).to.equal('failed');
    if (timedOut.status === 'failed') {
      expect(timedOut.reason).to.equal('timeout');
    }
    const syntax = await runProblemClassification(
      ports({ reasoner: new FakeProblemClassificationReasoner([new SyntaxError('bad json')]) }),
      problem,
    );
    expect(syntax.status).to.equal('failed');
    if (syntax.status === 'failed') {
      expect(syntax.reason).to.equal('malformed-response');
    }
    const malformed = await runProblemClassification(
      ports({ reasoner: new FakeProblemClassificationReasoner(['nope']) }),
      problem,
    );
    expect(malformed.status).to.equal('failed');
    if (malformed.status === 'failed') {
      expect(malformed.reason).to.equal('malformed-response');
    }
    const invalidEntity = await runProblemClassification(
      ports({
        reasoner: new FakeProblemClassificationReasoner([
          scriptedPayload({ frameworks: [{ entityId: 'framework.nope', confidence: 'high' }] }),
        ]),
      }),
      problem,
    );
    expect(invalidEntity.status).to.equal('failed');
    if (invalidEntity.status === 'failed') {
      expect(invalidEntity.reason).to.equal('invalid-entity');
    }
    // Failures persist nothing: the problem stays unclassified but usable.
    const check = ports();
    try {
      await runProblemClassification(
        { ...check, reasoner: new FakeProblemClassificationReasoner([new Error('down')]) },
        problem,
      );
      expect(await check.store.getClassification(problem.problemId)).to.be.null;
      expect(isUsableProblem(problem)).to.be.true;
    } finally {
      clean(check.dir);
    }
  });

  it('reports persistence failures without losing the validated result shape', async () => {
    const problem = rottingOranges();
    const brokenStore: ClassificationPorts['store'] = {
      saveClassification: async () => {
        throw new Error('disk full');
      },
      getClassification: async () => null,
      listClassifications: async () => [],
    };
    const outcome = await runProblemClassification(ports({ store: brokenStore }), problem);
    expect(outcome.status).to.equal('failed');
    if (outcome.status === 'failed') {
      expect(outcome.reason).to.equal('persistence-error');
    }
  });
});

// ---------------------------------------------------------------------------
// RETRIEVAL: the query layer future phases will use
// ---------------------------------------------------------------------------

describe('Phase C retrieval layer', () => {
  it('resolves a problem classification to canonical entities', () => {
    const graph = getDefaultKnowledgeGraph();
    const resolved = resolveProblemKnowledge(graph, stamped())!;
    expect(resolved.problemId).to.equal(rottingOranges().problemId);
    expect(resolved.status).to.equal('classified');
    expect(resolved.frameworks.map((r) => r.entity!.name)).to.include('BFS');
    expect(resolved.forms[0].entity!.id).to.equal('form.multisource-bfs');
    expect(resolved.unresolvedEntityIds).to.deep.equal([]);
  });

  it('reports dangling entity IDs explicitly after ontology evolution', () => {
    const graph = getDefaultKnowledgeGraph();
    const classification = stamped();
    const evolved = createKnowledgeGraph(
      [{ id: 'topic.graphs', type: 'topic', name: 'Graphs', description: 'Graphs.' }],
      [],
      [],
    );
    const resolved = resolveProblemKnowledge(evolved, classification)!;
    expect(resolved.unresolvedEntityIds).to.include('framework.bfs');
    expect(resolved.frameworks[0].entity).to.be.null;
    expect(resolved.topics[0].entity!.id).to.equal('topic.graphs');
  });

  it('looks up problem knowledge through the store by stable problemId', async () => {
    const dir = tmpDir('codesense-test-phase-c-retrieval');
    clean(dir);
    try {
      const store = new LocalClassificationStore(dir);
      const problem = rottingOranges();
      await store.saveClassification(stamped({ problemId: problem.problemId }));
      const knowledge = resolveProblemKnowledge(
        getDefaultKnowledgeGraph(),
        await store.getClassification(problem.problemId),
      )!;
      expect(knowledge.frameworks.map((r) => r.ref.entityId)).to.include('framework.bfs');
      // A different problem has no knowledge (stable-reference isolation).
      expect(await store.getClassification('prob_elsewhere')).to.be.null;
    } finally {
      clean(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// AI CONTEXT: classification is exposed as problem metadata, not learner state
// ---------------------------------------------------------------------------

describe('Phase C AI context exposure', () => {
  function fixtureContext(classification: ReturnType<typeof stamped> | null) {
    const problem = rottingOranges();
    const attempt = createAttempt({ attemptId: 'att_c', problemId: problem.problemId, sessionId: 'ses_c' });
    return buildAIContext({
      problem,
      attempt,
      previousAttempts: [],
      edits: [],
      checkpoints: [],
      sessionEvents: [],
      ...(classification ? { classification } : {}),
      now: '2026-01-01T00:00:00.000Z',
    });
  }

  it('leaves contexts byte-identical when no classification is present', () => {
    const text = renderContextForPrompt(fixtureContext(null));
    expect(text).to.contain('Rotting Oranges');
    expect(text).to.not.contain('Problem knowledge');
  });

  it('renders classification as problem metadata with explicit non-learner framing', () => {
    const classification = stamped();
    const text = renderContextForPrompt(fixtureContext(classification));
    expect(text).to.contain('Problem knowledge');
    expect(text).to.contain('NOT learner ability');
    expect(text).to.contain('framework.bfs (high)');
    expect(text).to.contain('form.multisource-bfs (medium)');
    expect(text).to.contain('overall confidence: high');
    expect(text).to.contain('AlgoZenith / Graph Level 1 / Multisource BFS → form.multisource-bfs');
    for (const key of ['mastery', 'weakness', 'proficiency']) {
      expect(text, key).to.not.contain(key);
    }
    expect(renderClassificationForPrompt(classification)).to.contain('WHAT this problem exercises');
  });
});
