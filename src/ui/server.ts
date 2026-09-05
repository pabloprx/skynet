// bun skynet.ts ui [--port N] [--build]: renders the architecture + lifecycle diagrams via the
// pinned archify CLI and serves them alongside the generation log. See CLAUDE.md / README "Web UI".
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { HOME, ROOT } from "../config.ts";
import { sh } from "../shell.ts";
import { buildArchitectureIR, buildLifecycleIR } from "./ir.ts";
import { traceDir, traceRows } from "../trace.ts";

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

async function ensureArchify() {
  const dir = archifyRoot();
  if (existsSync(archifyCli())) return;
  mkdirSync(HOME, { recursive: true });
  const cl = await sh(`git clone --depth 1 ${ARCHIFY_URL} ${JSON.stringify(dir)}`, HOME, 120_000);
  if (cl.code !== 0) throw new Error(`archify clone failed: ${cl.text.slice(-500)}`);
  const fetchCo = await sh(`git fetch --depth 1 origin ${ARCHIFY_SHA} && git checkout ${ARCHIFY_SHA}`, dir, 60_000);
  if (fetchCo.code !== 0) throw new Error(`archify checkout ${ARCHIFY_SHA} failed: ${fetchCo.text.slice(-500)}`);
}

interface DeliverResult { ok: boolean; error?: string }

async function deliverOne(type: "architecture" | "lifecycle", ir: unknown, jsonPath: string, htmlPath: string): Promise<DeliverResult> {
  await Bun.write(jsonPath, JSON.stringify(ir, null, 2));
  // "deliver --json" chokes on its own check receipt past 64KB (many warnings truncate the JSON);
  // "render" writes the same html without that receipt step, and exit code is enough to know it worked.
  const cmd = `node ${JSON.stringify(archifyCli())} render ${type} ${JSON.stringify(jsonPath)} ${JSON.stringify(htmlPath)} --quality standard`;
  const r = await sh(cmd, HOME, 60_000);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.text.slice(-1000) };
}

export interface BuildResult { archHtml: string; lifeHtml: string; archResult: DeliverResult; lifeResult: DeliverResult }

export async function buildUi(skynetRoot: string = ROOT, trDir: string = traceDir()): Promise<BuildResult> {
  await ensureArchify();
  const dir = uiDir();
  mkdirSync(dir, { recursive: true });
  const archHtml = join(dir, "architecture.html");
  const lifeHtml = join(dir, "lifecycle.html");
  const [archResult, lifeResult] = await Promise.all([
    deliverOne("architecture", buildArchitectureIR(skynetRoot), join(dir, "architecture.json"), archHtml),
    deliverOne("lifecycle", buildLifecycleIR(trDir), join(dir, "lifecycle.json"), lifeHtml),
  ]);
  return { archHtml, lifeHtml, archResult, lifeResult };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function logTableHtml(): string {
  const rows = traceRows();
  if (!rows.length) return "<p>no generations logged yet.</p>";
  const trs = rows.map((r) => `<tr><td>${r.gen}</td><td>${escapeHtml(r.event)}</td><td>$${r.cost.toFixed(4)}</td><td>${escapeHtml(r.goal)}</td></tr>`).join("");
  return `<table><thead><tr><th>gen</th><th>event</th><th>cost</th><th>goal</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function indexHtml(result: BuildResult): string {
  const err = (r: DeliverResult, label: string) => (r.ok ? "" : `<p class="err">${label} render failed: ${escapeHtml(r.error ?? "")}</p>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>skynet</title>
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

function serve(port: number) {
  Bun.serve({
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
  console.log(`skynet ui: http://localhost:${port}`);
}

export async function runUiCmd(args: string[]) {
  const portIdx = args.indexOf("--port");
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) : 4173;
  if (args.includes("--build")) {
    const result = await buildUi();
    console.log(`architecture: ${result.archHtml}`);
    console.log(`lifecycle: ${result.lifeHtml}`);
    if (!result.archResult.ok) console.error(`architecture deliver failed: ${result.archResult.error}`);
    if (!result.lifeResult.ok) console.error(`lifecycle deliver failed: ${result.lifeResult.error}`);
    return;
  }
  serve(port);
}
