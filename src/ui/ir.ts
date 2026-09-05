// builds the two archify diagram IRs (architecture module graph, lifecycle generation history)
// from skynet's own source tree and its trace log. See references/authoring-contract.md in the
// pinned archify clone for the schema this targets.
import { readFileSync } from "fs";
import { join, relative, dirname, basename } from "path";
import { readTraceFiles, type TraceEvent } from "../trace.ts";

type ComponentType = "frontend" | "backend" | "external";
export interface Component { id: string; type: ComponentType; label: string; sublabel: string; row: number; col: number; pos: [number, number]; size: [number, number] }
export interface Boundary { kind: "region"; label: string; wraps: string[] }
export interface Connection {
  id: string; from: string; to: string;
  fromSide: "right"; toSide: "left"; route: "orthogonal-h"; via: [number, number][];
}

// ---------- pixel layout constants ----------
// staircase layout: every component gets a globally unique row so a horizontal segment run at any
// node's row-centre y can never cross another node, regardless of which layer columns it spans.
const ROW_H = 90, ROW_ORIGIN = 80, NODE_W = 180, NODE_H = 56, GAP_X = 40;

// ---------- id / classification ----------
export function sanitizeId(relPath: string): string {
  return relPath.replace(/\.ts$/, "").replace(/[/.]/g, "_");
}

function componentType(relPath: string): ComponentType {
  if (relPath.startsWith("src/providers/")) return "external";
  if (relPath.startsWith("src/ui/")) return "frontend";
  return "backend";
}

function sublabelFor(source: string): string {
  const firstLine = source.split("\n")[0] ?? "";
  const comment = firstLine.match(/^\s*\/\/\s*(.+)/) ?? firstLine.match(/^\s*\/\*\*?\s*(.+)/);
  if (comment?.[1]) return comment[1].trim().slice(0, 30);
  const names: string[] = [];
  const re = /export\s+(?:async\s+function|function|class|const)\s+([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) && names.length < 2) if (m[1]) names.push(m[1]);
  return names.join(", ").slice(0, 30);
}

function scanFiles(root: string): string[] {
  const files = ["skynet.ts"];
  for (const f of new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })) {
    if (!f.endsWith(".test.ts")) files.push(f);
  }
  return files;
}

// ---------- import graph ----------
function extractImports(source: string): string[] {
  const re = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"](\.[^'"]+)['"]/g;
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) if (m[1]) specs.push(m[1]);
  return specs;
}

function resolveImport(root: string, fromRel: string, spec: string, fileSet: Set<string>): string | undefined {
  const raw = join(dirname(join(root, fromRel)), spec);
  const candidates = spec.endsWith(".ts") ? [raw] : [raw + ".ts", join(raw, "index.ts")];
  for (const c of candidates) {
    const rel = relative(root, c);
    if (fileSet.has(rel)) return rel;
  }
  return undefined;
}

function buildEdges(root: string, files: string[]): [string, string][] {
  const fileSet = new Set(files);
  const seen = new Set<string>();
  const edges: [string, string][] = [];
  for (const f of files) {
    const source = readFileSync(join(root, f), "utf8");
    for (const spec of extractImports(source)) {
      const target = resolveImport(root, f, spec, fileSet);
      if (!target) continue;
      const key = f + "->" + target;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([f, target]);
    }
  }
  return edges;
}

// ---------- layering: longest-path DAG layering via Kahn's algorithm ----------
// every file starts at indeg/layer 0 so lookups below are always defined (no ?? needed) - a node
// stuck in a cycle (ponytail: cycles broken by DFS visit order) never hits indegree 0 and just
// keeps its initial layer 0 rather than crashing.
function computeLayers(files: string[], edges: [string, string][]): Map<string, number> {
  const indeg = new Map(files.map((f) => [f, 0]));
  const layer = new Map(files.map((f) => [f, 0]));
  const adj = new Map<string, string[]>(files.map((f) => [f, []]));
  for (const [from, to] of edges) {
    adj.get(from)!.push(to);
    indeg.set(to, indeg.get(to)! + 1);
  }
  const queue = files.filter((f) => indeg.get(f) === 0);
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i]!;
    for (const next of adj.get(node)!) {
      layer.set(next, Math.max(layer.get(next)!, layer.get(node)! + 1));
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return layer;
}

// ---------- row/col assignment ----------
// staircase rows: every component gets a unique global row (ordered by layer, then name) so no two
// components ever share a row anywhere in the diagram - see the LAYER_W/ROW_H comment above.
function assignRowsCols(files: string[], layers: Map<string, number>): Map<string, { row: number; col: number }> {
  const ordered = [...files].sort((a, b) => layers.get(a)! - layers.get(b)! || a.localeCompare(b));
  const pos = new Map<string, { row: number; col: number }>();
  ordered.forEach((f, row) => pos.set(f, { row, col: layers.get(f)! }));
  return pos;
}

// ---------- boundaries: only emit a region whose members form a contiguous box nothing else sits in ----------
export function isContiguousRegion(memberIds: string[], components: Component[]): boolean {
  if (memberIds.length === 0) return false;
  const memberSet = new Set(memberIds);
  const members = components.filter((c) => memberSet.has(c.id));
  const minRow = Math.min(...members.map((c) => c.row));
  const maxRow = Math.max(...members.map((c) => c.row));
  const minCol = Math.min(...members.map((c) => c.col));
  const maxCol = Math.max(...members.map((c) => c.col));
  return components.every((c) => memberSet.has(c.id) || c.row < minRow || c.row > maxRow || c.col < minCol || c.col > maxCol);
}

function buildBoundaries(components: Component[]): Boundary[] {
  const groups: [ComponentType, string][] = [["external", "src/providers"], ["frontend", "src/ui"]];
  const out: Boundary[] = [];
  for (const [type, label] of groups) {
    const wraps = components.filter((c) => c.type === type).map((c) => c.id);
    if (isContiguousRegion(wraps, components)) out.push({ kind: "region", label, wraps });
  }
  return out;
}

// ---------- gap-column spreading: give every source component its own x inside the gap so
// connections sharing no endpoint never collide on the same vertical corridor (see
// collectAmbiguousCorridors in archify's geometry.mjs: only same-endpoint pairs are exempt). ----------
function columnIndices(positions: Map<string, { row: number; col: number }>): Map<string, number> {
  const byCol = new Map<number, string[]>();
  for (const [f, p] of positions) {
    if (!byCol.has(p.col)) byCol.set(p.col, []);
    byCol.get(p.col)!.push(f);
  }
  const index = new Map<string, number>();
  for (const files of byCol.values()) {
    files.sort((a, b) => positions.get(a)!.row - positions.get(b)!.row);
    files.forEach((f, i) => index.set(f, i));
  }
  return index;
}

function maxNodesPerCol(positions: Map<string, { row: number; col: number }>): number {
  const counts = new Map<number, number>();
  for (const p of positions.values()) counts.set(p.col, (counts.get(p.col) ?? 0) + 1);
  return Math.max(1, ...counts.values());
}

// layer width must fit the gap column: NODE_W for the node, GAP_X clearance on each side, plus
// 10px per source that column may need to fan its connections out on (widest column sets it).
function layerWidth(maxPerCol: number): number {
  return NODE_W + GAP_X + maxPerCol * 10 + GAP_X;
}

// ---------- top-level builder ----------
export interface ArchitectureIR {
  schema_version: 1;
  diagram_type: "architecture";
  meta: { title: string; quality_profile: "standard" };
  components: Component[];
  boundaries: Boundary[];
  connections: Connection[];
}

// every connection runs importer-right -> imported-left through a two-point via in the empty gap
// column just past the source's layer: out of the source at its row, down/up the gap column (never
// occupied by a node - see LAYER_W/NODE_W/GAP_X), then along the target's own (unique) row into it.
// (Anchors are plain rect-centre points - the renderer only offsets them via its own automatic port
// spreading, which is disabled by an explicit route/via, so every via here must start/end exactly on
// fromY/toY or the endpoint-side-direction gate rejects the now-diagonal first/last segment.)
function connectionFor(
  from: string,
  to: string,
  positions: Map<string, { row: number; col: number }>,
  colIndices: Map<string, number>,
  layerW: number,
): Connection {
  const fromPos = positions.get(from)!, toPos = positions.get(to)!;
  const fromY = ROW_ORIGIN + fromPos.row * ROW_H + NODE_H / 2;
  const toY = ROW_ORIGIN + toPos.row * ROW_H + NODE_H / 2;
  const gapX = fromPos.col * layerW + NODE_W + GAP_X + colIndices.get(from)! * 10;
  return {
    id: `${sanitizeId(from)}-${sanitizeId(to)}`,
    from: sanitizeId(from),
    to: sanitizeId(to),
    fromSide: "right",
    toSide: "left",
    route: "orthogonal-h",
    via: [[gapX, fromY], [gapX, toY]],
  };
}

export function buildArchitectureIR(root: string): ArchitectureIR {
  const files = scanFiles(root);
  const edges = buildEdges(root, files);
  const layers = computeLayers(files, edges);
  const positions = assignRowsCols(files, layers);
  const colIndices = columnIndices(positions);
  const layerW = layerWidth(maxNodesPerCol(positions));

  const components: Component[] = files.map((f) => {
    const source = readFileSync(join(root, f), "utf8");
    const { row, col } = positions.get(f)!;
    const pos: [number, number] = [col * layerW, ROW_ORIGIN + row * ROW_H];
    return { id: sanitizeId(f), type: componentType(f), label: basename(f, ".ts"), sublabel: sublabelFor(source), row, col, pos, size: [NODE_W, NODE_H] };
  });

  const connections: Connection[] = edges.map(([from, to]) => connectionFor(from, to, positions, colIndices, layerW));

  return {
    schema_version: 1,
    diagram_type: "architecture",
    meta: { title: "Skynet Module Graph", quality_profile: "standard" },
    components,
    boundaries: buildBoundaries(components),
    connections,
  };
}

// ---------- lifecycle ----------
type GenType = "success" | "failure" | "active";
interface GenState { gen: number; goal: string; cost: number; type: GenType }
interface LifecycleState { id: string; type: GenType | "neutral" | "start"; label: string; sublabel: string; lane: "main"; col: number }
interface Transition { id: string; from: string; to: string }

function collapseGen(gen: number, events: TraceEvent[]): GenState {
  const goal = events.find((e) => e.event === "start")?.goal ?? "";
  const cost = events.reduce((sum, e) => sum + (e.cost ?? 0), 0);
  const type: GenType = events.some((e) => e.event === "promoted")
    ? "success"
    : events.some((e) => e.event === "rejected" || e.event === "reverted")
      ? "failure"
      : "active";
  return { gen, goal: goal.slice(0, 24), cost, type };
}

function emptyLifecycle(): { states: LifecycleState[]; transitions: Transition[] } {
  return {
    states: [
      { id: "start", type: "start", label: "Start", sublabel: "no generations yet", lane: "main", col: 0 },
      { id: "summary", type: "neutral", label: "Summary", sublabel: "0 gens, 0 promoted, $0.00", lane: "main", col: 1 },
    ],
    transitions: [{ id: "start-summary", from: "start", to: "summary" }],
  };
}

// schema caps col 0..4 and 5 states in the lane: at most the last 4 generations plus one summary state.
function buildLifecycleStates(gens: GenState[]): { states: LifecycleState[]; transitions: Transition[] } {
  if (gens.length === 0) return emptyLifecycle();
  const shown = gens.length <= 4 ? gens : gens.slice(-4);
  const omitted = gens.length - shown.length;
  const promotedCount = gens.filter((g) => g.type === "success").length;
  const totalCost = gens.reduce((s, g) => s + g.cost, 0);
  const states: LifecycleState[] = shown.map((g, col) => ({
    id: `gen${g.gen}`, type: g.type, label: `Gen ${g.gen}`, sublabel: `$${g.cost.toFixed(2)} - ${g.goal}`, lane: "main", col,
  }));
  const summarySublabel = `${gens.length} gens, ${promotedCount} promoted, $${totalCost.toFixed(2)}` + (omitted > 0 ? ` (${omitted} earlier omitted)` : "");
  states.push({ id: "summary", type: "neutral", label: "Summary", sublabel: summarySublabel, lane: "main", col: states.length });
  const transitions: Transition[] = states.slice(1).map((s, i) => ({ id: `${states[i]!.id}-${s.id}`, from: states[i]!.id, to: s.id }));
  return { states, transitions };
}

export interface LifecycleIR {
  schema_version: 1;
  diagram_type: "lifecycle";
  meta: { title: string; quality_profile: "standard" };
  lanes: { id: "main"; label: string }[];
  states: LifecycleState[];
  transitions: Transition[];
}

export function buildLifecycleIR(dir: string): LifecycleIR {
  const gens = readTraceFiles(dir).map(({ gen, events }) => collapseGen(gen, events));
  const { states, transitions } = buildLifecycleStates(gens);
  return {
    schema_version: 1,
    diagram_type: "lifecycle",
    meta: { title: "Skynet Evolve Generations", quality_profile: "standard" },
    lanes: [{ id: "main", label: "Generations" }],
    states,
    transitions,
  };
}
