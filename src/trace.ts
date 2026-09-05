// evolve/adopt generation trace: append-only JSONL, one file per generation, read back for the ui.
import { existsSync, mkdirSync, appendFileSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { HOME } from "./config.ts";

export const traceDir = () => join(HOME, "trace");

export interface TraceEvent {
  t: string;
  gen: number;
  event: string;
  goal?: string;
  cost?: number;
  reason?: string;
  provider?: string;
  model?: string;
  turn?: number;
}

// dir param (default HOME/trace) lets tests point at a tmp dir without relying on mutating
// process.env - HOME in config.ts is a module-load const, so an env mutation after import is a no-op.
export function appendTrace(gen: number, event: string, extra: Record<string, unknown> = {}, dir: string = traceDir()) {
  mkdirSync(dir, { recursive: true });
  const line: TraceEvent = { t: new Date().toISOString(), gen, event, ...extra };
  appendFileSync(join(dir, `gen-${gen}.jsonl`), JSON.stringify(line) + "\n");
}

export function readTraceFiles(dir: string = traceDir()): { gen: number; events: TraceEvent[] }[] {
  if (!existsSync(dir)) return [];
  const gens = readdirSync(dir)
    .map((f) => f.match(/^gen-(\d+)\.jsonl$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return gens.map((gen) => ({
    gen,
    events: readFileSync(join(dir, `gen-${gen}.jsonl`), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as TraceEvent),
  }));
}

// one row per generation for "skynet.ts log" and the ui's log table: cost/turns are "so far" -
// a gen with a "start" event but no "promoted"/"rejected"/"reverted" is still running (or was
// killed mid-run, e.g. SIGINT - it then stays "running" forever, there's no way to tell the two
// apart from the trace file alone).
export interface GenSummary { gen: number; status: "running" | "promoted" | "rejected"; turns: number; cost: number; goal: string; reason?: string }

export function genSummaries(dir: string = traceDir()): GenSummary[] {
  return readTraceFiles(dir).map(({ gen, events }) => summarizeGen(gen, events));
}

function summarizeGen(gen: number, events: TraceEvent[]): GenSummary {
  const goal = events.find((e) => e.event === "start")?.goal ?? "";
  const turns = events.filter((e) => e.event === "turn").length;
  // "turn" events and the terminal promoted/rejected event both carry the *cumulative* cost so
  // far, not a per-event delta - take the last one seen rather than summing (summing would
  // double-count the turns already folded into the terminal event's total).
  const costs = events.map((e) => e.cost).filter((c): c is number => c !== undefined);
  const cost = costs.length ? costs[costs.length - 1]! : 0;
  const rejected = events.find((e) => e.event === "rejected" || e.event === "reverted");
  const status: GenSummary["status"] = events.some((e) => e.event === "promoted") ? "promoted" : rejected ? "rejected" : "running";
  return { gen, status, turns, cost, goal, reason: rejected?.reason };
}

function statusLabel(r: GenSummary): string {
  if (r.status === "running") return `running (turn ${r.turns})`;
  if (r.status === "rejected") return `rejected: ${r.reason ?? ""}`;
  return "promoted";
}

export function printLog() {
  const rows = genSummaries();
  if (!rows.length) return console.log("no generations logged yet.");
  console.log("gen\tstatus\tturns\tcost\tgoal");
  for (const r of rows) console.log(`${r.gen}\t${statusLabel(r)}\t${r.turns}\t$${r.cost.toFixed(4)}\t${r.goal.slice(0, 80)}`);
}
