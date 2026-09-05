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

// flat rows for "skynet.ts log" and the ui's log table
export function traceRows(dir: string = traceDir()): { gen: number; event: string; cost: number; goal: string }[] {
  const rows: { gen: number; event: string; cost: number; goal: string }[] = [];
  for (const { gen, events } of readTraceFiles(dir)) {
    for (const e of events) rows.push({ gen, event: e.event, cost: e.cost ?? 0, goal: e.goal ?? e.reason ?? "" });
  }
  return rows;
}

export function printLog() {
  const rows = traceRows();
  if (!rows.length) return console.log("no generations logged yet.");
  console.log("gen\tevent\tcost\tgoal");
  for (const r of rows) console.log(`${r.gen}\t${r.event}\t$${r.cost.toFixed(4)}\t${r.goal}`);
}
