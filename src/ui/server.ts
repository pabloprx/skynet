// bun skynet.ts ui [--port N] [--build]: renders the architecture + lifecycle diagrams via the
// pinned archify CLI and serves them alongside the generation log. See CLAUDE.md / README "Web UI".
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { HOME, ROOT } from "../config.ts";
import { sh } from "../shell.ts";
import { buildArchitectureIR, buildLifecycleIR } from "./ir.ts";
import { traceDir, genSummaries, type GenSummary } from "../trace.ts";

const ARCHIFY_URL = "https://github.com/tt-a1i/archify";
const ARCHIFY_SHA = "5769acefcc2ebd696a4f9ed3ac9cb6cca1d75c70";

function archifyRoot(): string {
  return process.env.SKYNET_ARCHIFY ?? join(HOME, "archify");
}
function archifyCli(): string {
  return join(archifyRoot(), "archify", "bin", "archify.mjs");
}
function uiDir(): string {
  return join(HOME, "ui");
}

// re-verifies the pinned SHA on every call for the auto-managed default location, instead of
// trusting existsSync(archifyCli()) alone: that alone would (a) never notice archify.mjs got
// replaced by something else entirely (e.g. an agent's bash tool writing outside its own working
// dir — see isBlockedCmd's ceiling comment — planting a durable backdoor the human later runs)
// and (b) permanently brick the command on a partial clone/checkout failure, since a re-run's
// `git clone` into the same non-empty leftover dir just fails forever. Any mismatch (wrong SHA,
// no .git, missing dir) gets the directory wiped and re-cloned from the pinned SHA. An explicit
// SKYNET_ARCHIFY override is left untouched either way — it names a checkout the caller vouches
// for, pinned SHA or not, so it's only ever read, never rewritten.
async function ensureArchify() {
  const dir = archifyRoot();
  if (process.env.SKYNET_ARCHIFY) {
    if (!existsSync(archifyCli())) throw new Error(`SKYNET_ARCHIFY=${dir} has no archify/bin/archify.mjs`);
    return;
  }
  const rev = existsSync(dir) ? (await sh("git rev-parse HEAD", dir)).text.trim() : "";
  if (rev === ARCHIFY_SHA) return;
  if (existsSync(dir)) await sh(`rm -rf ${JSON.stringify(dir)}`, HOME);
  mkdirSync(HOME, { recursive: true });
  const cl = await sh(`git clone --depth 1 ${ARCHIFY_URL} ${JSON.stringify(dir)}`, HOME, 120_000);
  if (cl.code !== 0) throw new Error(`archify clone failed: ${cl.text.slice(-500)}`);
  const fetchCo = await sh(`git fetch --depth 1 origin ${ARCHIFY_SHA} && git checkout ${ARCHIFY_SHA}`, dir, 60_000);
  if (fetchCo.code !== 0) throw new Error(`archify checkout ${ARCHIFY_SHA} failed: ${fetchCo.text.slice(-500)}`);
}

interface RenderResult { ok: boolean; error?: string }

async function renderOne(type: "architecture" | "lifecycle", ir: unknown, jsonPath: string, htmlPath: string): Promise<RenderResult> {
  await Bun.write(jsonPath, JSON.stringify(ir, null, 2));
  // "deliver --json" chokes on its own check receipt past 64KB (many warnings truncate the JSON);
  // "render" writes the same html without that receipt step, and exit code is enough to know it worked.
  const cmd = `node ${JSON.stringify(archifyCli())} render ${type} ${JSON.stringify(jsonPath)} ${JSON.stringify(htmlPath)} --quality standard`;
  const r = await sh(cmd, HOME, 60_000);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.text.slice(-1000) };
}

export interface BuildResult { archHtml: string; lifeHtml: string; archResult: RenderResult; lifeResult: RenderResult }

export async function buildUi(skynetRoot: string = ROOT, trDir: string = traceDir()): Promise<BuildResult> {
  await ensureArchify();
  const dir = uiDir();
  mkdirSync(dir, { recursive: true });
  const archHtml = join(dir, "architecture.html");
  const lifeHtml = join(dir, "lifecycle.html");
  const [archResult, lifeResult] = await Promise.all([
    renderOne("architecture", buildArchitectureIR(skynetRoot), join(dir, "architecture.json"), archHtml),
    renderOne("lifecycle", buildLifecycleIR(trDir), join(dir, "lifecycle.json"), lifeHtml),
  ]);
  return { archHtml, lifeHtml, archResult, lifeResult };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function statusCellHtml(r: GenSummary): string {
  if (r.status === "running") return `running (turn ${r.turns})`;
  return escapeHtml(r.status);
}

function logTableHtml(): string {
  const rows = genSummaries();
  if (!rows.length) return "<p>no generations logged yet.</p>";
  const trs = rows
    .map(
      (r) =>
        `<tr><td>${r.gen}</td><td>${statusCellHtml(r)}</td><td>${r.turns}</td><td>$${r.cost.toFixed(4)}</td><td>${escapeHtml(r.goal.slice(0, 80))}</td><td>${escapeHtml(r.status === "rejected" ? (r.reason ?? "") : "")}</td></tr>`,
    )
    .join("");
  return `<table><thead><tr><th>gen</th><th>status</th><th>turns</th><th>cost</th><th>goal</th><th>reason</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function indexHtml(result: BuildResult): string {
  const err = (r: RenderResult, label: string) => (r.ok ? "" : `<p class="err">${label} render failed: ${escapeHtml(r.error ?? "")}</p>`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>skynet</title>
<style>
body{background:#111;color:#eee;font-family:ui-monospace,monospace;padding:2rem;max-width:900px;margin:0 auto}
a{color:#6cf} table{border-collapse:collapse;width:100%} td,th{border:1px solid #444;padding:4px 8px;text-align:left}
.err{color:#f66} nav a{margin-right:1rem;font-size:1.2rem}
</style></head><body>
<h1>skynet</h1>
<nav><a href="/architecture.html">architecture</a><a href="/lifecycle.html">lifecycle</a></nav>
${err(result.archResult, "architecture")}${err(result.lifeResult, "lifecycle")}
<h2>generations</h2>
${logTableHtml()}
</body></html>`;
}

// shared by the standalone "ui" command and evolve/adopt's auto-started UI; throws (e.g. port
// already in use) rather than swallowing errors - callers decide what "already running" means.
export function startServer(port: number) {
  return Bun.serve({
    port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(indexHtml(await buildUi()), { headers: { "content-type": "text/html" } });
      if (path === "/architecture.html" || path === "/lifecycle.html") {
        const file = Bun.file(join(uiDir(), path.slice(1)));
        return (await file.exists()) ? new Response(file) : new Response("not built yet - visit / first", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

function serve(port: number) {
  const server = startServer(port);
  // log the actual bound port, not the requested one: --port 0 asks the OS for a free port, so
  // the literal CLI argument is never the real address.
  console.log(`skynet ui: http://localhost:${server.port}`);
}

export const DEFAULT_UI_PORT = 3333;

export function uiPort(): number {
  const raw = Number(process.env.SKYNET_UI_PORT);
  return Number.isInteger(raw) && raw >= 0 && raw <= 65535 ? raw : DEFAULT_UI_PORT;
}

// evolve()/adopt() call this at startup so a live run's log/lifecycle diagram are visible without
// a separate `ui` invocation: starts the server in-process on `uiPort()`, or - if that port is
// already taken (by another skynet run, most likely) - just reports the same URL. Never blocks
// the caller (Bun.serve is non-blocking) and unref()s the handle so it alone can't keep the
// process alive once the run finishes. A child (SKYNET_CHILD set) never starts a server.
export function maybeStartUi(enabled: boolean): void {
  if (!enabled || process.env.SKYNET_CHILD) return;
  const port = uiPort();
  try {
    const server = startServer(port);
    server.unref();
    console.log(`ui: http://localhost:${server.port}`);
  } catch {
    console.log(`ui: http://localhost:${port}`);
  }
}

// --port 0 is a real, intentional value ("ask the OS for a free port"), so this can't reuse
// parsePositiveIntegerFlag (which rejects 0) - same shape, different floor.
function parsePortFlag(raw: string | undefined): number {
  const value = raw === undefined ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`--port must be an integer 0-65535 (got ${raw ?? "missing value"})`);
  }
  return value;
}

export async function runUiCmd(args: string[]) {
  if (process.env.SKYNET_CHILD) throw new Error("ui: refusing to run inside a child (SKYNET_CHILD is set)");
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? parsePortFlag(args[portIdx + 1]) : 4173;
  if (args.includes("--build")) {
    const result = await buildUi();
    console.log(`architecture: ${result.archHtml}`);
    console.log(`lifecycle: ${result.lifeHtml}`);
    if (!result.archResult.ok) console.error(`architecture deliver failed: ${result.archResult.error}`);
    if (!result.lifeResult.ok) console.error(`lifecycle deliver failed: ${result.lifeResult.error}`);
    if (!result.archResult.ok || !result.lifeResult.ok) throw new Error("ui --build: one or more renders failed");
    return;
  }
  serve(port);
}
