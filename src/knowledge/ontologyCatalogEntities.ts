import {
  CurriculumSourceMapping,
  KnowledgeEntity,
  KnowledgeRelationship,
} from './ontologyTypes';

/**
 * Phase C canonical DSA knowledge catalog — DATA, not architecture.
 *
 * Reconciliation note (AlgoZenith dump vs ontology proposal):
 * - Source curricula are preserved ONLY as `ONTOLOGY_CURRICULUM_MAPPINGS`.
 *   Nothing from a source heading becomes canonical by copying; every
 *   entity below is a normalized, reusable knowledge unit.
 * - "Form N" / "Application N" / bare practice titles ("KWALK",
 *   "Minimum Penalty", "Hard Problem") are kept as `unknown` mappings
 *   with the raw label intact — never promoted, never interpreted.
 * - Sliding-Window Forms 0–3 carry disambiguating subtitles IN the raw
 *   dump itself ("Form 0: Fixed Window", ...), so they map to the matching
 *   forms with `medium` confidence and an evidence note. That is
 *   source-grounded mapping, not hallucination; genuinely bare labels
 *   stay `unknown` (see above).
 *
 * Conventions:
 * - IDs are stable (`<type>.<slug>`). Rename names freely; never rename IDs.
 * - To add knowledge: append an entity + relationships + optional mappings.
 *   No enum, switch, UI, or learner-model change is ever required.
 */

export const ONTOLOGY_ENTITIES: KnowledgeEntity[] = [
  // ------------------------------------------------------------------
  // Topics (top-level organizing domains; presentation aid, not parents)
  // ------------------------------------------------------------------
  { id: 'topic.foundations', type: 'topic', name: 'Foundations & Computational Thinking', description: 'Complexity reasoning, constraint analysis, decomposition, and invariants that underpin every other domain.' },
  { id: 'topic.arrays-hashing', type: 'topic', name: 'Arrays, Hashing & Basic Data Processing', description: 'Index-based storage, frequency analysis, and hash-map-powered lookup that turn nested search into constant-time queries.' },
  { id: 'topic.linked-lists', type: 'topic', name: 'Linked Lists', description: 'Node-based sequences, pointer rewiring, and classic list manipulations from reversal to cycle detection.' },
  { id: 'topic.stacks-queues', type: 'topic', name: 'Stacks, Queues & Deques', description: 'LIFO/FIFO disciplines, matching and frontier processing, monotonic structures, and windowed extrema.' },
  { id: 'topic.heaps', type: 'topic', name: 'Heaps & Priority Queues', description: 'Dynamic extrema, top-K selection, scheduling, and streaming order statistics via heap invariants.' },
  { id: 'topic.binary-search', type: 'topic', name: 'Searching & Binary Search', description: 'Sorted search, boundary maintenance, monotone predicates, and search-on-answer over index or value spaces.' },
  { id: 'topic.two-pointers-sliding-window', type: 'topic', name: 'Two Pointers & Sliding Window', description: 'Linear scans with coordinated pointers: converging, same-direction, fixed/expanding windows, and multi-sequence merges.' },
  { id: 'topic.prefix-sums', type: 'topic', name: 'Prefix / Partial Sums & Contribution Techniques', description: 'Precomputed aggregates, difference updates, and counting by per-element contribution instead of enumeration.' },
  { id: 'topic.sorting-intervals-sweep', type: 'topic', name: 'Sorting, Intervals & Sweep Line', description: 'Order-exposing transformations, interval reasoning, event sweeps, and coordinate compression.' },
  { id: 'topic.greedy', type: 'topic', name: 'Greedy', description: 'Locally-optimal choices with global-optimality arguments: scheduling, allocation, and exchange proofs.' },
  { id: 'topic.recursion-backtracking', type: 'topic', name: 'Recursion, Backtracking & Divide and Conquer', description: 'Recursive state design, exhaustive search with pruning, problem splitting, and halved-space meeting in the middle.' },
  { id: 'topic.trees', type: 'topic', name: 'Trees & Tree Algorithms', description: 'Binary trees, BSTs, traversals, LCA with binary lifting, Euler tours, and tree-aggregated prefix sums.' },
  { id: 'topic.graphs', type: 'topic', name: 'Graphs', description: 'Traversal, connectivity, cycles, ordering, shortest paths, spanning trees, and advanced connectivity and flow.' },
  { id: 'topic.dynamic-programming', type: 'topic', name: 'Dynamic Programming', description: 'State definition and transition design across knapsack, sequence, grid, interval, game, tree, bitmask, and digit forms.' },
  { id: 'topic.strings', type: 'topic', name: 'Strings & String Algorithms', description: 'Matching automata, prefix functions, palindromes, periodicity, and hashing-based substring reasoning.' },
  { id: 'topic.tries', type: 'topic', name: 'Tries', description: 'Prefix trees for strings and bitwise tries for XOR-ordered queries over binary representations.' },
  { id: 'topic.bit-manipulation', type: 'topic', name: 'Bit Manipulation', description: 'Bitwise operators, masks, subset encodings, XOR structure, and per-bit contribution counting.' },
  { id: 'topic.range-structures', type: 'topic', name: 'Range Data Structures', description: 'Fenwick trees, segment trees with lazy propagation, order statistics, and block decomposition for range queries.' },
  { id: 'topic.maths', type: 'topic', name: 'Mathematics for DSA', description: 'Modular arithmetic, number theory, combinatorics, and pigeonhole reasoning used inside algorithmic solutions.' },
  { id: 'topic.advanced-cross-domain', type: 'topic', name: 'Advanced / Cross-Domain Techniques', description: 'Optimizations and algorithms that span domains, such as convex-hull DP optimization and network flow.' },

  // ------------------------------------------------------------------
  // Concepts (reusable underlying ideas)
  // ------------------------------------------------------------------
  { id: 'concept.time-complexity', type: 'concept', name: 'Time & Space Complexity', description: 'Asymptotic cost of an approach in time and memory, including amortized and recursion-depth reasoning.' },
  { id: 'concept.constraint-mapping', type: 'concept', name: 'Constraint-to-Complexity Mapping', description: 'Reading input limits (n <= 20 vs 1e5 vs 1e9) to admit or rule out whole algorithm families before coding.' },
  { id: 'concept.invariants', type: 'concept', name: 'Invariants', description: 'A precisely stated property (sorted prefix, BFS frontier, monotone stack, DP subproblem meaning) that stays true throughout execution.' },
  { id: 'concept.brute-force-baseline', type: 'concept', name: 'Brute-Force Baseline', description: 'The naive enumeration stated first so refinements (pruning, memoization, re-framing) have something to improve on.' },
  { id: 'concept.hash-lookup', type: 'concept', name: 'Hash-Based Lookup', description: 'Replacing repeated scans with key-value or membership queries over previously seen elements.' },
  { id: 'concept.complement-lookup', type: 'concept', name: 'Complement Lookup', description: 'Rewriting a pair or subarray condition as a lookup for the missing complement in a map or set.' },
  { id: 'concept.frequency-counting', type: 'concept', name: 'Frequency Counting', description: 'Counting occurrences with arrays or maps to answer grouping, duplicate, and distinctness questions.' },
  { id: 'concept.stack-lifo', type: 'concept', name: 'LIFO Discipline', aliases: ['LIFO'], description: 'Last-in-first-out processing for nested, matched, or reversal-structured data.' },
  { id: 'concept.queue-fifo', type: 'concept', name: 'FIFO Discipline', aliases: ['FIFO'], description: 'First-in-first-out frontier processing that yields level order and shortest-path order in unweighted graphs.' },
  { id: 'concept.heap-invariant', type: 'concept', name: 'Heap Invariant', description: 'A partially ordered structure that always exposes the current minimum or maximum in logarithmic time.' },
  { id: 'concept.top-k-selection', type: 'concept', name: 'Top-K Selection', description: 'Keeping only the K most extreme elements seen so far instead of fully sorting a stream.' },
  { id: 'concept.monotonicity', type: 'concept', name: 'Monotonicity', description: 'A predicate or sequence that flips at most once, which is what makes binary search and two-pointer movement sound.' },
  { id: 'concept.feasibility-predicate', type: 'concept', name: 'Feasibility Predicate', description: 'A yes/no decision version feasible(x) of an optimization problem, searched over the answer space.' },
  { id: 'concept.search-space', type: 'concept', name: 'Search Space & Boundaries', description: 'Explicit low/high bounds, midpoint choice, and boundary maintenance that keep a search sound and terminating.' },
  { id: 'concept.prefix-aggregation', type: 'concept', name: 'Prefix Aggregation', description: 'Precomputed running aggregates so any prefix, subarray, or rectangle query answers in constant time.' },
  { id: 'concept.difference-updates', type: 'concept', name: 'Difference / Partial Updates', description: 'Range additions recorded at endpoints and materialized once, turning many range updates into linear work.' },
  { id: 'concept.contribution-counting', type: 'concept', name: 'Contribution Counting', description: 'Counting how much each element, pair, or bit contributes to the answer instead of enumerating all objects.' },
  { id: 'concept.exchange-argument', type: 'concept', name: 'Exchange Argument', description: 'Proving a greedy choice safe by showing any optimal solution can be exchanged to include it without getting worse.' },
  { id: 'concept.sweep-events', type: 'concept', name: 'Sweep Events & Active Sets', description: 'Converting intervals or geometry into sorted start/end events with a maintained active set while scanning.' },
  { id: 'concept.coordinate-compression', type: 'concept', name: 'Coordinate Compression', description: 'Mapping large sparse coordinates to compact indices while preserving order, usually before a range structure.' },
  { id: 'concept.recursive-state', type: 'concept', name: 'Recursive State & Base Cases', description: 'What a recursive call promises to solve, how it shrinks toward a base case, and how results combine.' },
  { id: 'concept.choose-recurse-undo', type: 'concept', name: 'Choose-Recurse-Undo', description: 'The backtracking skeleton: pick a candidate, recurse, then restore state so siblings explore cleanly.' },
  { id: 'concept.connected-components', type: 'concept', name: 'Connected Components', description: 'Maximal mutually-reachable vertex sets; counting, sizing, and aggregating them via traversal or union-find.' },
  { id: 'concept.graph-modeling', type: 'concept', name: 'Graph Modelling', aliases: ['Graph Formulation'], description: 'Turning states into nodes and transitions into edges so a non-graph problem becomes a traversal or shortest-path problem.' },
  { id: 'concept.directed-acyclic-graph', type: 'concept', name: 'Directed Acyclic Graphs', aliases: ['DAG', 'Directed Acyclic Graph'], description: 'Directed graphs without cycles: dependency structure that admits topological orderings and linear-time DP.' },
  { id: 'concept.cycle-structure', type: 'concept', name: 'Cycles', description: 'Closed walks that force special handling: detection, coloring state, parent tracking, and cycle reconstruction.' },
  { id: 'concept.topological-order', type: 'concept', name: 'Topological Order', description: 'A linear vertex order respecting all directed edges; exists exactly for DAGs and encodes scheduling validity.' },
  { id: 'concept.bridges-articulation', type: 'concept', name: 'Bridges & Articulation Points', aliases: ['Articulation Points', 'Bridges', 'Cut Vertices', 'Cut Edges'], description: 'Edges and vertices whose removal disconnects the graph, found via DFS discovery/low-link structure.' },
  { id: 'concept.optimal-substructure', type: 'concept', name: 'Optimal Substructure', description: 'Optimal answers built from optimal answers to smaller subproblems — the license to use dynamic programming.' },
  { id: 'concept.overlapping-subproblems', type: 'concept', name: 'Overlapping Subproblems', description: 'Repeated subproblem instances that make memoization or tabulation asymptotically better than plain recursion.' },
  { id: 'concept.dp-state-design', type: 'concept', name: 'DP State Definition', description: 'Choosing what a DP cell means precisely; the single decision from which transitions, bases, and order all follow.' },
  { id: 'concept.rolling-hash', type: 'concept', name: 'Rolling / Polynomial Hashing', aliases: ['String Hashing', 'Polynomial Hash', 'Polynomial Rolling Hash'], description: 'Prefix hashes that make substring equality, comparison, and palindrome checks constant-time with collision awareness.' },
  { id: 'concept.string-periodicity', type: 'concept', name: 'String Periodicity', description: 'Repeating block structure of strings exposed by prefix functions and Z-values.' },
  { id: 'concept.bitmask-subset', type: 'concept', name: 'Bitmask Subset Representation', aliases: ['Bitmasking', 'Bit Masks', 'Subset Masks'], description: 'Encoding small sets as integer bit patterns so subsets enumerate, combine, and transition with bit operations.' },
  { id: 'concept.xor-identities', type: 'concept', name: 'XOR Identities & Properties', aliases: ['XOR Properties'], description: 'Self-inverse, commutativity, and bit-independence of XOR that turn pairing and prefix problems into linear ones.' },
  { id: 'concept.range-aggregation', type: 'concept', name: 'Range Aggregation', description: 'Associative combines (sum, min, gcd, bracket balance) maintained over intervals by tree or block structures.' },
  { id: 'concept.lazy-invariant', type: 'concept', name: 'Lazy Propagation Invariant', description: 'Deferred range updates stored at tree nodes and pushed only when a query or deeper update needs them.' },
  { id: 'concept.modular-arithmetic', type: 'concept', name: 'Modular Arithmetic', description: 'Remainder algebra: negative handling, fast exponentiation, inverses, and large-answer reduction modulo 1e9+7 style primes.' },
  { id: 'concept.gcd-lcm', type: 'concept', name: 'GCD & LCM', aliases: ['GCD', 'LCM', 'Euclidean Algorithm', 'Greatest Common Divisor'], description: 'Euclidean structure of divisibility used for reduction, periodicity, path aggregates, and counting.' },
  { id: 'concept.prime-factorization', type: 'concept', name: 'Primes, Divisors & Factorization', aliases: ['Divisors', 'Prime Factorization', 'Prime Checking'], description: 'Primality, divisor enumeration, sieve-generated primes, and factorization-based counting.' },
  { id: 'concept.counting-principles', type: 'concept', name: 'Counting Principles', aliases: ['Combinatorics', 'nCr', 'Inclusion-Exclusion'], description: 'Systematic counting: permutations, combinations, inclusion-exclusion, derangements, and closed-form sums.' },
  { id: 'concept.pigeonhole', type: 'concept', name: 'Pigeonhole Principle', description: 'Collision guarantees from counting constraints that force a repeated value, pair, or residue class.' },
  { id: 'concept.convex-hull-optimization', type: 'concept', name: 'Convex Hull Optimization', aliases: ['CHT', 'Convex Hull Trick'], description: 'Speeding DP transitions over lines or monotone queries with a convex-hull structure instead of linear scans.' },
  { id: 'concept.state-compression', type: 'concept', name: 'State Compression', aliases: ['State Space Reduction', 'State Rotation'], description: 'Shrinking DP state (dropping dimensions, rotating layers, sorting states) while preserving transition correctness.' },

  // ------------------------------------------------------------------
  // Frameworks (recognizable solution approaches, incl. structure-driven ones)
  // ------------------------------------------------------------------
  { id: 'framework.bfs', type: 'framework', name: 'BFS', aliases: ['Breadth-First Search', 'Breadth First Search'], description: 'Queue-ordered traversal that visits vertices by increasing distance; the unweighted shortest-path framework.' },
  { id: 'framework.dfs', type: 'framework', name: 'DFS', aliases: ['Depth-First Search', 'Depth First Search'], description: 'Depth-first traversal with visited state, timestamps, and recursion or explicit stacks for structure discovery.' },
  { id: 'framework.zero-one-bfs', type: 'framework', name: '0-1 BFS', aliases: ['0-1 BFS', '01 BFS', '0/1 BFS'], description: 'Deque-based shortest paths for edge weights restricted to 0 and 1.' },
  { id: 'framework.dijkstra', type: 'framework', name: 'Dijkstra', aliases: ["Dijkstra's", "Dijkstra's Algorithm"], description: 'Priority-queue shortest paths for non-negative edge weights via settled-distance order.' },
  { id: 'framework.bellman-ford', type: 'framework', name: 'Bellman-Ford', aliases: ['Bellman Ford', 'Bellman-Ford Algorithm'], description: 'Relaxation-based shortest paths that tolerate negative edges and detect negative cycles.' },
  { id: 'framework.floyd-warshall', type: 'framework', name: 'Floyd-Warshall', aliases: ['Floyd Warshall', 'All-Pairs Shortest Path'], description: 'Cubic all-pairs shortest paths by progressively admitting intermediate vertices.' },
  { id: 'framework.topological-sort', type: 'framework', name: 'Topological Sort', aliases: ['Topo Sort', 'Topological Ordering', 'Topological Sorting'], description: 'DFS- or Kahn/BFS-based linear ordering of DAG dependencies, including lexicographically smallest variants.' },
  { id: 'framework.dsu', type: 'framework', name: 'DSU / Union-Find', aliases: ['Union Find', 'Union-Find', 'Disjoint Set Union', 'DSU', 'Disjoint Union'], description: 'Near-constant connectivity queries and merges with path compression and union by size or rank.' },
  { id: 'framework.kruskal', type: 'framework', name: 'Kruskal (MST)', aliases: ["Kruskal's", "Kruskal's Algorithm", 'Minimum Spanning Tree'], description: 'Greedy spanning-tree construction adding cheapest edges that join different DSU components.' },
  { id: 'framework.prim', type: 'framework', name: 'Prim (MST)', aliases: ["Prim's", "Prim's Algorithm"], description: 'Spanning-tree growth from a frontier of cheapest connecting edges, usually heap-driven.' },
  { id: 'framework.strongly-connected-components', type: 'framework', name: 'Strongly Connected Components', aliases: ['SCC', 'Strongly Connected Components', 'Kosaraju', 'Tarjan SCC'], description: 'Maximal mutually-reachable sets in directed graphs and their condensation into a DAG.' },
  { id: 'framework.max-flow', type: 'framework', name: 'Network Flow', aliases: ['Max Flow', 'Maximum Flow', 'Min-Cost Max-Flow', 'Dinic'], description: 'Pushing maximum feasible flow (optionally at minimum cost) through capacitated networks with residual graphs.' },
  { id: 'framework.binary-search', type: 'framework', name: 'Binary Search', description: 'Halving a monotone index or answer space with explicit boundaries until the transition point is isolated.' },
  { id: 'framework.two-pointers', type: 'framework', name: 'Two Pointers', description: 'Coordinated pointer pairs (converging, same-direction, multi-sequence) that exploit order to stay linear.' },
  { id: 'framework.sliding-window', type: 'framework', name: 'Sliding Window', description: 'A maintained subarray window with an expand/shrink invariant for fixed, variable, and multi-sequence forms.' },
  { id: 'framework.greedy', type: 'framework', name: 'Greedy', description: 'Repeated locally-optimal choices justified by exchange, dominance, or matroid-style feasibility preservation.' },
  { id: 'framework.sweep-line', type: 'framework', name: 'Sweep Line', aliases: ['Sweep Line', 'Line Sweep'], description: 'Scanning sorted events while maintaining an active set to resolve overlaps, coverage, and intervals.' },
  { id: 'framework.recursion', type: 'framework', name: 'Recursion', description: 'Solving by self-similar subcalls with base cases, progress guarantees, and return-value accumulation.' },
  { id: 'framework.backtracking', type: 'framework', name: 'Backtracking', description: 'Exhaustive candidate search with constraint checks, pruning, and choose-recurse-undo state discipline.' },
  { id: 'framework.divide-and-conquer', type: 'framework', name: 'Divide and Conquer', aliases: ['Divide and Conquer', 'Divide & Conquer'], description: 'Splitting into independent halves, solving recursively, and merging (sorting, inversions, Karatsuba-style).' },
  { id: 'framework.meet-in-the-middle', type: 'framework', name: 'Meet in the Middle', aliases: ['Meet in the Middle', 'Meet-in-the-Middle'], description: 'Halving an exponential space, enumerating each half, and combining compatible half-results.' },
  { id: 'framework.dynamic-programming', type: 'framework', name: 'Dynamic Programming', aliases: ['DP', 'Dynamic Programming'], description: 'State-transition optimization over DAG-shaped subproblems via memoization or ordered tabulation.' },
  { id: 'framework.kmp', type: 'framework', name: 'KMP', aliases: ['KMP', 'Knuth-Morris-Pratt'], description: 'Linear pattern matching with a prefix/failure function that never re-scans text characters.' },
  { id: 'framework.z-algorithm', type: 'framework', name: 'Z-Algorithm', aliases: ['Z Algorithm', 'Z-Algorithm', 'Z-Function', 'Z Function'], description: 'Linear longest-prefix-match array at every position for matching, periodicity, and overlap analysis.' },
  { id: 'framework.manacher', type: 'framework', name: "Manacher's Algorithm", aliases: ['Manacher', "Manacher's", "Manacher's Algorithm"], description: 'Linear longest-palindromic-substring via mirrored radii around centers.' },
  { id: 'framework.monotonic-stack', type: 'framework', name: 'Monotonic Stack', description: 'A stack kept in sorted order to resolve nearest-greater/smaller, histogram, and rain-water structure linearly.' },
  { id: 'framework.sieve', type: 'framework', name: 'Sieve of Eratosthenes', aliases: ['Sieve of Eratosthenes', 'Sieve'], description: 'Crossing out multiples to generate all primes (or smallest factors) up to a bound in near-linear time.' },
  { id: 'framework.binary-lifting', type: 'framework', name: 'Binary Lifting', description: 'Powers-of-two ancestor jumps for LCA, k-th ancestors, and path aggregates in logarithmic time.' },
  { id: 'framework.segment-tree', type: 'framework', name: 'Segment Tree', aliases: ['Segment Tree', 'Segtree', 'Seg Tree'], description: 'Hierarchical interval aggregation supporting point updates, range queries, and lazy range updates.' },
  { id: 'framework.fenwick-tree', type: 'framework', name: 'Fenwick Tree', aliases: ['Fenwick Tree', 'Binary Indexed Tree', 'BIT'], description: 'Compact prefix-aggregation structure for point updates with prefix queries and order statistics.' },
  { id: 'framework.trie', type: 'framework', name: 'Trie', aliases: ['Trie', 'Prefix Tree'], description: 'Shared-prefix tree over characters or bits for prefix queries, autocomplete, and XOR-ordered search.' },
  { id: 'framework.kadane', type: 'framework', name: "Kadane's Algorithm", aliases: ['Kadane', "Kadane's", "Kadane's Algorithm", 'Maximum Subarray'], description: 'Linear maximum-subarray scan carrying the best ending-here value; the running-optimum DP idiom.' },

  // ------------------------------------------------------------------
  // Forms (recurring structural forms of a framework)
  // ------------------------------------------------------------------
  { id: 'form.grid-bfs', type: 'form', name: 'Grid BFS', aliases: ['Grid BFS'], description: 'BFS over implicit grid neighbors with bounds checks and visited marking, often in-place.' },
  { id: 'form.multisource-bfs', type: 'form', name: 'Multi-source BFS', aliases: ['Multi-source BFS', 'Multi Source BFS', 'Multiple Source BFS', 'Multisource BFS'], description: 'BFS seeded with many initial sources at distance zero, propagating distance or time (rotting, spread, nearest-source).' },
  { id: 'form.state-space-bfs', type: 'form', name: 'State-space BFS', aliases: ['State-space BFS', 'State Space BFS'], description: 'BFS where nodes are problem states (configurations, remainders, masks) and edges are legal transitions.' },
  { id: 'form.grid-dfs', type: 'form', name: 'Grid DFS', aliases: ['Grid DFS'], description: 'DFS flood over grid cells for regions, perimeters, islands, and component aggregation.' },
  { id: 'form.kahn-toposort', type: 'form', name: 'Kahn BFS Topological Sort', aliases: ["Kahn's Algorithm", 'BFS Topological Sort', 'Indegree Topological Sort'], description: 'Topological ordering by repeatedly emitting zero-indegree vertices with a queue.' },
  { id: 'form.dfs-toposort', type: 'form', name: 'DFS Topological Sort', aliases: ['DFS Topological Sort'], description: 'Topological ordering from DFS finish times, reversed.' },
  { id: 'form.bipartite-coloring', type: 'form', name: 'Bipartite 2-Coloring', aliases: ['Bipartite Coloring', '2-Coloring', 'Two Coloring', 'Bipartite Check'], description: 'BFS/DFS two-coloring that assigns teams or detects the odd cycle proving non-bipartiteness.' },
  { id: 'form.fixed-window', type: 'form', name: 'Fixed Sliding Window', aliases: ['Fixed Window', 'Fixed-Size Window', 'Fixed Length Window'], description: 'A constant-size window sliding by one with incremental aggregate maintenance (sums, extrema, penalties).' },
  { id: 'form.variable-window', type: 'form', name: 'Variable Sliding Window', aliases: ['Variable Window', 'Variable-Size Window'], description: 'Expand-right / shrink-left windows that maintain validity for longest-distinct, shortest-valid, and at-most-K families.' },
  { id: 'form.converging-window', type: 'form', name: 'Converging Two Pointers', aliases: ['Converging Window', 'Converging Type', 'Converging Pointers', 'Opposite Direction Pointers'], description: 'Pointers moving inward from both ends of sorted data (pair/triple sums, container-style constraints).' },
  { id: 'form.multisequence-window', type: 'form', name: 'Multi-sequence Window', aliases: ['Multisequence Window', 'Multi-sequence Window', 'Multi-sequence Type'], description: 'Coordinated scanning across several sequences or streams with merge-style pointer advancement.' },
  { id: 'form.sliding-window-maximum', type: 'form', name: 'Sliding Window Extrema', aliases: ['Maximum in Window', 'Sliding Window Maximum', 'Window Maximum', 'Minimum in Window'], description: 'Monotonic-deque maintenance of window maxima or minima in amortized constant time per slide.' },
  { id: 'form.binary-search-rotated', type: 'form', name: 'Rotated Array Search', aliases: ['Rotated Sorted Array', 'Rotated Array Search', 'Search in Rotated Array'], description: 'Binary search that first reasons about which half stays sorted after rotation.' },
  { id: 'form.binary-search-bitonic', type: 'form', name: 'Bitonic / Mountain Search', aliases: ['Bitonic Array', 'Mountain Array Search', 'Peak Finding'], description: 'Peak isolation plus directed search on the rising and falling slopes of a bitonic array.' },
  { id: 'form.search-on-answer', type: 'form', name: 'Binary Search on Answer', aliases: ['Binary Search on Answer', 'Search on Answer', 'Minimize Maximum', 'Minimise Max Diff'], description: 'Binary-searching the feasible answer value via a monotone feasibility predicate (painters, classrooms, kth sums).' },
  { id: 'form.real-domain-search', type: 'form', name: 'Real-Domain Search', aliases: ['Binary Search on Real Domain', 'Real Domain Search', 'Ternary Search'], description: 'Binary (or ternary) search over continuous domains with precision-based termination.' },
  { id: 'form.lower-upper-bound', type: 'form', name: 'Lower / Upper Bounds', aliases: ['Lower Bound', 'Upper Bound', 'First and Last Occurrence'], description: 'Boundary-finding variants that locate first/last feasible positions rather than exact values.' },
  { id: 'form.knapsack-01', type: 'form', name: '0/1 Knapsack', aliases: ['0/1 Knapsack', '01 Knapsack', 'Knapsack', 'Subset Sum Queries'], description: 'Take-or-skip DP over capacity with subset-sum reachability as the decision core.' },
  { id: 'form.subset-sum', type: 'form', name: 'Subset Sum', aliases: ['Subset Sum'], description: 'Reachability DP over achievable sums, the counting/decision kernel behind knapsack variants.' },
  { id: 'form.unbounded-knapsack', type: 'form', name: 'Unbounded / Infinite-Supply Knapsack', aliases: ['Unbounded Knapsack', 'Infinite Supply Knapsack', 'Coin Change'], description: 'Knapsack with unlimited reuse; iteration order decides between combinations and permutations.' },
  { id: 'form.lis', type: 'form', name: 'Longest Increasing Subsequence', aliases: ['LIS', 'Longest Increasing Subsequence', 'Count LIS'], description: 'Sequence DP for increasing structure, from quadratic DP to patience-sorting with reconstruction.' },
  { id: 'form.lcs-two-sequence', type: 'form', name: 'Two-Sequence DP (LCS family)', aliases: ['LCS', 'Longest Common Subsequence', 'Longest Common Substring'], description: 'DP over pairs of positions for commonality, transformation, and supersequence problems.' },
  { id: 'form.edit-distance', type: 'form', name: 'Edit Distance', aliases: ['Edit Distance'], description: 'Insert/delete/replace DP as the canonical string-transformation cost model.' },
  { id: 'form.grid-dp', type: 'form', name: 'Grid DP', aliases: ['Grid DP', 'Grid Paths', 'Maximum Path Score', 'Number of Paths in Grid'], description: 'DP over rows and columns with obstacle, cost, and multi-dimensional-state extensions.' },
  { id: 'form.interval-dp', type: 'form', name: 'Interval / LR DP', aliases: ['Interval DP', 'LR DP', 'Matrix Chain Multiplication', 'Merge Elements'], description: 'DP over shrinking or growing intervals with split-point transitions (chains, merges, palindromic structure).' },
  { id: 'form.game-dp', type: 'form', name: 'Game DP', aliases: ['Game DP', 'Subtraction Game', 'Optimal Game Strategy', 'Win Lose DP'], description: 'Win/lose and minimax-style DP over game states with optimal-play transitions.' },
  { id: 'form.state-machine-dp', type: 'form', name: 'State-Machine DP', aliases: ['State Machine DP', 'Holding State DP'], description: 'Explicit holding/mode states with constrained transitions (stocks, toggles, staged processes).' },
  { id: 'form.bitmask-dp', type: 'form', name: 'Bitmask DP', aliases: ['Bitmask DP', 'DP with Bitmasking'], description: 'DP over visited-set or assignment masks for small-N exponential structure (TSP-like, tiling, counting).' },
  { id: 'form.digit-dp', type: 'form', name: 'Digit DP', aliases: ['Digit DP'], description: 'Position-by-position number construction with tight and leading-zero flags for bounded counting.' },
  { id: 'form.tree-dp', type: 'form', name: 'Tree DP', aliases: ['Tree DP'], description: 'Subtree-state DP with parent-to-child transitions: distances, colorings, rerooting, and aggregations.' },
  { id: 'form.prefix-sum-2d', type: 'form', name: '2D Prefix / Difference Sums', aliases: ['2D Prefix Sums', '2D Prefix Sum', 'Rectangle Sum Query', '2D Partial Sums'], description: 'Integral-image aggregates for rectangle, triangle, and max-value region queries with difference updates.' },
  { id: 'form.lca-binary-lifting', type: 'form', name: 'LCA with Binary Lifting', aliases: ['LCA', 'Lowest Common Ancestor', 'Classical LCA', 'K-th Ancestor', 'Path GCD'], description: 'Ancestor jumps with depth/parent tables, extended to path aggregates such as GCD or minima.' },
  { id: 'form.euler-tour-flattening', type: 'form', name: 'Euler Tour Flattening', aliases: ['Euler Tour', 'Subtree Flattening', 'Entry Exit Times'], description: 'Entry/exit-time linearization turning subtree queries into contiguous range queries.' },
  { id: 'form.tree-prefix-sums', type: 'form', name: 'Tree Prefix / Partial Sums', aliases: ['Tree Prefix Sums', 'Tree Partial Sums', 'Partial Sum on Tree'], description: 'Root-to-node accumulation and difference-on-tree techniques for path aggregation.' },
  { id: 'form.string-trie-queries', type: 'form', name: 'String Trie Queries', aliases: ['String Trie', 'Autocomplete', 'Prefix Queries', 'Good Substrings'], description: 'Terminal-marked character transitions answering prefix existence, counting, and suggestion queries.' },
  { id: 'form.kth-segment-tree', type: 'form', name: 'K-th Order Statistic Tree', aliases: ['K-th Segment Tree', 'Kth Segment Tree', 'Order Statistics Tree', 'Order of Heights'], description: 'Frequency segment trees that walk down to the k-th present element.' },
  { id: 'form.merge-intervals', type: 'form', name: 'Merge Intervals', aliases: ['Merge Intervals'], description: 'Sort-by-start then linear merging as the canonical interval-canonicalization step.' },
  { id: 'form.interval-scheduling', type: 'form', name: 'Interval Scheduling', aliases: ['Interval Scheduling', 'Activity Selection'], description: 'Maximum compatible subset via earliest-finish greedy ordering.' },
  { id: 'form.median-two-heaps', type: 'form', name: 'Two-Heaps Median', aliases: ['Running Median', 'Two Heaps', 'Running Mean Median Mode'], description: 'Balanced lower/upper heaps maintaining a running median over a stream.' },
  { id: 'form.k-way-merge', type: 'form', name: 'K-Way Merge', aliases: ['Merge K Sorted Lists', 'K-Way Merge', 'Merge Sorted Lists'], description: 'Heap-driven merging of many sorted sequences with one candidate per sequence in flight.' },
  { id: 'form.list-reversal', type: 'form', name: 'In-place List Reversal', aliases: ['Reverse Linked List', 'Reverse List', 'Reverse in Groups'], description: 'Pointer rewiring (full, grouped, or partial) with dummy-node and multi-pointer discipline.' },
  { id: 'form.permutation-generation', type: 'form', name: 'Permutation Generation', aliases: ['Permutations', 'Generating Permutations', 'Kth Permutation'], description: 'Ordered arrangement enumeration with used-tracking or factorial indexing, including k-th variants.' },
  { id: 'form.subset-combination-generation', type: 'form', name: 'Subset / Combination Generation', aliases: ['Subsets', 'Combinations', 'Target Subsets'], description: 'Include/exclude recursion or bitmask enumeration over selection spaces with duplicate handling.' },
  { id: 'form.constraint-satisfaction-search', type: 'form', name: 'Constraint Satisfaction Search', aliases: ['N-Queens', 'Sudoku Solver', 'Constraint Satisfaction', 'K Knights'], description: 'Backtracking with incremental validity checks and pruning over placement or assignment spaces.' },
  { id: 'form.segmented-sieve', type: 'form', name: 'Segmented Sieve', aliases: ['Segmented Sieve'], description: 'Sieving interval windows with base primes for ranges far beyond a single array.' },
  { id: 'form.substring-hash-query', type: 'form', name: 'Substring Hash Queries', aliases: ['Substring Hash', 'String Hash Query', 'Prefix Suffix Middle'], description: 'Constant-time substring equality and overlap checks from prefix hashes, forward and reversed.' },
  { id: 'form.next-greater-element', type: 'form', name: 'Next Greater / Smaller Element', aliases: ['Next Greater Element', 'Nearest Greater', 'Nearest Smaller', 'Nearest Smaller Values'], description: 'Monotonic-stack resolution of nearest-extreme queries, the kernel of histogram and rain-water forms.' },
  { id: 'form.inversion-count', type: 'form', name: 'Inversion Counting', aliases: ['Count Inversions', 'Inversion of Array'], description: 'Merge-sort-augmented pair counting as the canonical divide-and-conquer measurement.' },
  { id: 'form.split-enumerate-combine', type: 'form', name: 'Split-Enumerate-Combine', aliases: ['Four Number Sum', 'Four Values', 'Target Subset Meet in Middle'], description: 'Half-space enumeration with hash- or sort-based compatible-half lookup.' },

  // ------------------------------------------------------------------
  // Patterns (recognizable problem structures / transformations)
  // ------------------------------------------------------------------
  { id: 'pattern.connected-component-exploration', type: 'pattern', name: 'Component Exploration', description: 'Explore-and-measure every reachable region: counts, sizes, perimeters, and aggregated properties.' },
  { id: 'pattern.shortest-path-unweighted', type: 'pattern', name: 'Shortest Path in Unweighted Graph', aliases: ['Shortest Path in Unweighted Graph', 'Unweighted Shortest Path'], description: 'Distance-as-levels recognition: the moment edge weights are uniform, BFS is the shortest-path tool.' },
  { id: 'pattern.distance-time-propagation', type: 'pattern', name: 'Distance / Time Propagation', description: 'Frontier-carried arrival times over grids or graphs (spread, infection, burning) with level-synchronized expansion.' },
  { id: 'pattern.level-order-exploration', type: 'pattern', name: 'Level-Order Exploration', aliases: ['Level Order', 'Level-order Exploration', 'Zigzag Level Order'], description: 'Processing discrete depth layers with explicit level boundaries for layer-indexed answers.' },
  { id: 'pattern.flood-fill', type: 'pattern', name: 'Flood Fill', aliases: ['Flood Fill', 'Number of Rooms', 'Area and Perimeter of Connected Components'], description: 'Recoloring or measuring a contiguous region from a seed cell with guarded expansion.' },
  { id: 'pattern.implicit-graph', type: 'pattern', name: 'Implicit Graph Modelling', aliases: ['Implicit Graph', 'Jump Game as Graph', 'Snakes and Ladders as Graph', 'Budget Travelling'], description: 'Seeing states and moves as an unmaterialized graph so traversal machinery applies to puzzles and jumps.' },
  { id: 'pattern.complement-lookup', type: 'pattern', name: 'Two-Sum Complement Pattern', aliases: ['Two Sum Pattern', 'Complement Pair', 'Achieve Target Sum'], description: 'Single-pass pair finding by looking up each element’s complement among predecessors.' },
  { id: 'pattern.prefix-sum-hashmap', type: 'pattern', name: 'Prefix-Sum + Hash Map', aliases: ['Subarray Sum with Hash Map', 'Prefix Hash Map', 'Number of Subarrays with Sum K'], description: 'Counting subarrays by storing prefix frequencies and querying the needed delta.' },
  { id: 'pattern.interval-overlap', type: 'pattern', name: 'Interval Overlap Reasoning', aliases: ['Interval Overlap', 'Overlapping Intervals', 'Destroying Intervals'], description: 'Overlap, containment, and destruction questions resolved after sorting by endpoints.' },
  { id: 'pattern.sweep-active-set', type: 'pattern', name: 'Sweep with Active Set', aliases: ['Active Set Sweep', 'Solve Intervals'], description: 'Maximum overlap, coverage, and scheduling answers read off a maintained active set during the sweep.' },
  { id: 'pattern.monotonic-nearest', type: 'pattern', name: 'Monotonic Nearest-Extreme', aliases: ['Nearest Greater or Smaller', 'Largest Rectangle', 'Rain Water', 'Super Minimum Sum'], description: 'Boundaries of influence for each element found monotonically (rectangles, trapped water, contribution spans).' },
  { id: 'pattern.contribution-per-element', type: 'pattern', name: 'Per-Element Contribution', aliases: ['Contribution Technique', 'Element Contribution', 'Difference of Contributions'], description: 'Answer assembled from what each position contributes across all subarrays or pairs.' },
  { id: 'pattern.per-bit-contribution', type: 'pattern', name: 'Per-Bit Contribution', aliases: ['Bit Contribution', 'Per-bit Counting', 'Prefix Sums of Bits'], description: 'Bitwise answers built by counting set bits per position, often with bit-prefix sums.' },
  { id: 'pattern.compress-then-query', type: 'pattern', name: 'Compress-then-Query', description: 'Large sparse coordinates compressed onto a Fenwick or segment tree for range updates and queries.' },
  { id: 'pattern.streaming-top-k', type: 'pattern', name: 'Streaming Top-K', aliases: ['Top K Stream', 'Top K Elements', 'Magical Candy Bag'], description: 'Repeatedly extracting and reinserting extrema as new candidates arrive.' },
  { id: 'pattern.palindromic-structure', type: 'pattern', name: 'Palindromic Structure', aliases: ['Palindrome Recognition', 'Longest Palindromic Substring', 'Palindromic Number'], description: 'Mirror symmetry exploited via expansion, hashing, Manacher radii, or interval DP.' },
  { id: 'pattern.string-period-check', type: 'pattern', name: 'String Period Analysis', aliases: ['Period of String', 'Prefix Suffix Overlap'], description: 'Border and Z-structure revealing repetition, tiling, and overlap between strings.' },
  { id: 'pattern.xor-subarray', type: 'pattern', name: 'XOR Subarray Reasoning', aliases: ['XOR Subarray', 'Max XOR Subarray', 'Subarrays with XOR Less Than K', 'Maximum XOR'], description: 'Prefix-XOR plus bit-trie queries turning subarray conditions into path searches.' },
  { id: 'pattern.tree-diameter', type: 'pattern', name: 'Tree Diameter', aliases: ['Tree Diameter', 'Diameter of Tree', 'Diameter of Binary Tree'], description: 'Longest tree path via double traversal or height-combining DFS with global maximum tracking.' },

  // ------------------------------------------------------------------
  // Variants (meaningful specializations; may have several parents)
  // ------------------------------------------------------------------
  { id: 'variant.bit-trie', type: 'variant', name: 'Bit Trie', aliases: ['BIT Trie', 'Binary Trie', 'XOR Trie'], description: 'Trie over binary representations enabling maximum-XOR and threshold queries in bit-length steps.' },
  { id: 'variant.lazy-segment-tree', type: 'variant', name: 'Lazy Segment Tree', aliases: ['Lazy Segment Tree', 'Lazy Propagation Tree', 'Range Update Segment Tree'], description: 'Segment tree with deferred range updates and push/pull discipline for range-update range-query workloads.' },
  { id: 'variant.morris-traversal', type: 'variant', name: 'Morris Traversal', aliases: ['Morris Traversal', 'Morris Order Traversal'], description: 'Threaded-pointer inorder/preorder traversal using O(1) extra space by temporarily rewiring null links.' },
  { id: 'variant.rolling-array-dp', type: 'variant', name: 'Rolling-Array DP', aliases: ['Rolling Array', 'Space Optimized DP', 'Space Reduction', 'Rolling Arrays'], description: 'Keeping only the DP layers the transition reads, trading retained history for constant-factor memory.' },
  { id: 'variant.small-to-large-merging', type: 'variant', name: 'Small-to-Large Merging', aliases: ['Small to Large', 'Small-to-Large Merging', 'DSU on Tree'], description: 'Always folding the smaller set into the larger for logarithmic total merge cost across DSU or tree DP.' },
  { id: 'variant.rollback-dsu', type: 'variant', name: 'Rollback DSU', aliases: ['Rollback DSU', 'Rollback Union Find', 'Undoable DSU'], description: 'Union-find with an operation stack supporting undo for divide-and-conquer-over-time connectivity.' },
  { id: 'variant.weighted-union-find', type: 'variant', name: 'Weighted Union-Find', aliases: ['Weighted Union Find', 'Weighted DSU', 'Potential DSU'], description: 'Union-find carrying relative potentials or weights to answer difference and ratio queries between elements.' },
  { id: 'variant.explicit-stack-dfs', type: 'variant', name: 'Explicit-Stack DFS', aliases: ['Iterative DFS', 'Explicit Stack Traversal'], description: 'DFS with a manual stack (and simulated timestamps) avoiding recursion limits while preserving traversal order.' },

  // ------------------------------------------------------------------
  // Tactics (concrete reusable solving/implementation techniques)
  // ------------------------------------------------------------------
  { id: 'tactic.read-constraints-first', type: 'tactic', name: 'Read Constraints Before Choosing', description: 'Let n-bounds pick the algorithm family before any code is written.' },
  { id: 'tactic.estimate-operation-count', type: 'tactic', name: 'Estimate Operation Count', description: 'Multiply loops by limits to confirm the approach fits time before implementing.' },
  { id: 'tactic.visited-on-enqueue', type: 'tactic', name: 'Mark Visited on Enqueue', aliases: ['Mark Visited on Enqueue', 'Visited-on-Enqueue'], description: 'Mark BFS nodes visited when pushed, not when popped, to prevent exponential re-enqueueing.' },
  { id: 'tactic.inplace-visited-marking', type: 'tactic', name: 'In-place Visited Marking', aliases: ['In-place Visited Marking', 'Mark Visited In-place'], description: 'Reuse the grid itself for visited state when mutation is allowed, saving the auxiliary set.' },
  { id: 'tactic.distance-array-init', type: 'tactic', name: 'Distance Array Initialization', description: 'Seed distances with infinity, sources with zero, and relax only on strict improvement.' },
  { id: 'tactic.parent-tracking-dfs', type: 'tactic', name: 'Parent Tracking in DFS', aliases: ['Parent Tracking'], description: 'Pass the DFS parent explicitly so the back edge is not mistaken for an undirected cycle.' },
  { id: 'tactic.expand-right-shrink-left', type: 'tactic', name: 'Expand Right, Shrink Left', aliases: ['Expand Right Shrink Left'], description: 'Grow the window with right, restore validity by advancing left — the sliding-window motion pair.' },
  { id: 'tactic.maintain-window-frequency', type: 'tactic', name: 'Maintain Window Frequency', description: 'Incrementally update counts on expand/shrink so validity checks stay constant-time.' },
  { id: 'tactic.define-feasible-predicate', type: 'tactic', name: 'Write feasible(x)', aliases: ['Write feasible(x)', 'Define Candidate Answer'], description: 'Isolate the decision check for search-on-answer so monotonicity can be reasoned about alone.' },
  { id: 'tactic.prove-monotonicity', type: 'tactic', name: 'Prove Monotonicity', description: 'Argue the predicate flips once before binary-searching it; no proof, no search.' },
  { id: 'tactic.sort-before-two-pointers', type: 'tactic', name: 'Sort Before Two Pointers', aliases: ['Sort Before Two Pointers'], description: 'Sort first so pointer movement has a direction with a soundness argument.' },
  { id: 'tactic.maintain-monotonic-stack', type: 'tactic', name: 'Maintain a Monotonic Stack', description: 'Pop while the invariant breaks, then push; each element enters and leaves exactly once.' },
  { id: 'tactic.use-dummy-sentinel-node', type: 'tactic', name: 'Dummy / Sentinel Node', aliases: ['Dummy Node', 'Sentinel Node'], description: 'Anchor list edits at a throwaway head so empty-list and head-removal edge cases vanish.' },
  { id: 'tactic.fast-slow-pointers', type: 'tactic', name: 'Fast / Slow Pointers', aliases: ['Fast and Slow Pointers', 'Tortoise and Hare', 'Floyd Cycle Detection'], description: 'Two speeds over a list or cycle: middles, cycle entry, and k-th-from-end without lengths.' },
  { id: 'tactic.maintain-global-maximum', type: 'tactic', name: 'Maintain a Global Maximum', description: 'Track the best answer seen across recursion or scans (diameters, path scores, histogram areas).' },
  { id: 'tactic.use-prefix-sums', type: 'tactic', name: 'Use Prefix Sums', aliases: ['Use Prefix Sums', 'Prefix Sum Optimization'], description: 'Replace inner recomputation loops with precomputed aggregates, including inside DP transitions.' },
  { id: 'tactic.store-complement-lookup', type: 'tactic', name: 'Store-then-Lookup Complements', description: 'Record each element as you go so later elements query the past in constant time.' },
  { id: 'tactic.compress-coordinates-action', type: 'tactic', name: 'Compress Coordinates, Then Query', description: 'Sort unique coordinates, remap, and run the range structure over compact indices.' },
  { id: 'tactic.use-memoization', type: 'tactic', name: 'Memoize Recursive States', aliases: ['Memoization'], description: 'Cache solved states keyed by their exact parameters when recursion revisits them.' },
  { id: 'tactic.reduce-dp-state', type: 'tactic', name: 'Reduce DP State', aliases: ['State Reduction'], description: 'Drop or rotate DP dimensions (Cherry-Pickup style) after proving the transition never reads them.' },
  { id: 'tactic.exchange-argument-proof', type: 'tactic', name: 'Write the Exchange Proof', description: 'Concretely perform the swap argument for the greedy choice instead of asserting safety.' },
  { id: 'tactic.binary-lifting-table', type: 'tactic', name: 'Build Parent / Depth Tables', aliases: ['Parent Depth Tables', 'Binary Lifting Table'], description: 'Preprocess 2^k ancestors with depths so LCA and k-th-ancestor queries lift in log steps.' },
  { id: 'tactic.push-pull-lazy', type: 'tactic', name: 'Push / Pull Lazy Values', aliases: ['Push Pull Lazy'], description: 'Propagate pending updates before descending and recombine children after updating.' },
  { id: 'tactic.path-compression-union', type: 'tactic', name: 'Path Compression + Union by Size', aliases: ['Path Compression', 'Union by Size', 'Union by Rank'], description: 'Flatten find paths and attach smaller trees under larger ones for amortized near-constant DSU.' },
  { id: 'tactic.process-events-sorted', type: 'tactic', name: 'Sort Events, Order Ties Carefully', aliases: ['Sort Events', 'Event Tie Ordering'], description: 'Convert intervals to events, sort them, and define start/end tie order before sweeping.' },

  // ------------------------------------------------------------------
  // Capabilities (separate cross-cutting tooling layer — NOT DSA topics)
  // ------------------------------------------------------------------
  { id: 'capability.language-collections-api', type: 'capability', name: 'Language Collections API', layer: 'tooling', aliases: ['deque', 'heapq', 'bisect', 'collections', 'Queue API', 'HashMap API'], description: 'Idiomatic containers and helpers of the implementation language (queues, heaps, binary search, counters).' },
  { id: 'capability.cpp-stl-containers', type: 'capability', name: 'C++ STL Containers', layer: 'tooling', aliases: ['STL', 'vector', 'set', 'multiset', 'map', 'priority_queue', 'bitset'], description: 'C++ standard containers, their complexity guarantees, and iterator discipline.' },
  { id: 'capability.recursion-limit-awareness', type: 'capability', name: 'Recursion Limit Awareness', layer: 'tooling', aliases: ['Recursion Depth', 'Recursion Limit', 'Stack Overflow Awareness'], description: 'Knowing when deep recursion overflows the call stack and switching to explicit stacks or iteration.' },
];
