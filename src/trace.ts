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
  pid?: number;
  stage?: string;
  ms?: number;
  cmd?: string;
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

// $ and duration formatting shared by the CLI log, the ui table and the lifecycle map, so the
// three can never disagree on how a number reads (they used to: toFixed(2) vs toFixed(4)).
export const fmtCost = (c: number) => "$" + c.toFixed(4);
export const msSince = (iso: string) => (iso ? Date.now() - Date.parse(iso) : 0);
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// a process is "alive" if signal 0 delivery doesn't fail with ESRCH; EPERM (owned by someone
// else, e.g. re-run as another user) still counts as alive - only ESRCH proves it's gone.
function alive(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

// one row per generation for "skynet.ts log" and the ui's log table: cost/turns/stage/goal are
// "so far". A gen with a "start" event but no terminal (promoted/rejected/reverted) event is
// "running" while its start pid is still alive, else "killed" - it died without a terminal event
// (SIGINT, OOM, host reboot) rather than being a live run the UI just hasn't refreshed.
export interface GenSummary {
  gen: number;
  status: "running" | "promoted" | "rejected" | "killed";
  stage: string;
  turns: number;
  cost: number;
  goal: string;
  reason?: string;
  pid?: number;
  lastCmd?: string;
  startedAt: string;
  lastEventAt: string;
}

export function genSummaries(dir: string = traceDir()): GenSummary[] {
  return readTraceFiles(dir).map(({ gen, events }) => summarizeGen(gen, events));
}

function lastOf<K extends keyof TraceEvent>(events: TraceEvent[], key: K): TraceEvent[K] | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]![key] !== undefined) return events[i]![key];
  return undefined;
}

function statusOf(startPid: number | undefined, terminal: TraceEvent | undefined): GenSummary["status"] {
  if (!terminal) return alive(startPid) ? "running" : "killed";
  return terminal.event === "promoted" ? "promoted" : "rejected";
}

function stageOf(events: TraceEvent[], terminal: TraceEvent | undefined): string {
  if (terminal) return terminal.event;
  return lastOf(events, "stage") ?? "start";
}

// pulled out of summarizeGen purely to keep summarizeGen's own eslint `complexity` count down -
// each optional-chain/nullish access below counts as a branch on whichever function it's written in.
function eventTime(e: TraceEvent | undefined, fallback: TraceEvent | undefined): string {
  if (e) return e.t;
  if (fallback) return fallback.t;
  return "";
}

function isTerminal(e: TraceEvent): boolean {
  return e.event === "promoted" || e.event === "rejected" || e.event === "reverted";
}

function summarizeGen(gen: number, events: TraceEvent[]): GenSummary {
  const turns = events.filter((e) => e.event === "turn").length;
  const startEvent = events.find((e) => e.event === "start");
  const terminal = events.find(isTerminal);
  const startPid = startEvent?.pid;
  return {
    gen,
    turns,
    // "turn" events and the terminal promoted/rejected event both carry the *cumulative* cost so
    // far, not a per-event delta - take the last one seen rather than summing (summing would
    // double-count the turns already folded into the terminal event's total).
    cost: lastOf(events, "cost") ?? 0,
    goal: lastOf(events, "goal") ?? "",
    status: statusOf(startPid, terminal),
    stage: stageOf(events, terminal),
    reason: terminal?.reason,
    pid: startPid,
    lastCmd: lastOf(events, "cmd"),
    startedAt: eventTime(startEvent, events[0]),
    lastEventAt: eventTime(events[events.length - 1], events[0]),
  };
}

function statusLabel(r: GenSummary): string {
  if (r.status === "running") return `running (turn ${r.turns})`;
  if (r.status === "killed") return `killed (turn ${r.turns})`;
  if (r.status === "rejected") return `rejected: ${r.reason ?? ""}`;
  return "promoted";
}

export function printLog() {
  const rows = genSummaries();
  if (!rows.length) return console.log("no generations logged yet.");
  console.log("gen\tstatus\tstage\tturns\telapsed\tage\tcost\tlast cmd\tgoal");
  for (const r of rows) {
    const elapsed = fmtDuration(msSince(r.startedAt));
    const age = fmtDuration(msSince(r.lastEventAt));
    console.log(`${r.gen}\t${statusLabel(r)}\t${r.stage}\t${r.turns}\t${elapsed}\t${age}\t${fmtCost(r.cost)}\t${(r.lastCmd ?? "").slice(0, 60)}\t${r.goal.slice(0, 80)}`);
  }
}
