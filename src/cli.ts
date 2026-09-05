import { DEPTH, VERSION } from "./config.ts";
import { run } from "./agent.ts";
import { evolve, revert, parseEvolveFlags, parsePositiveIntegerFlag } from "./evolve.ts";
import { adopt, parseAdoptFlags } from "./adopt.ts";
import { printLog } from "./trace.ts";

const USAGE = "usage: bun skynet.ts <git-url|path> [--max-turns N] | evolve [--generations N] [--goal text|url|path] [--max-turns N] [--budget usd] | adopt <git-url> [--ref ref] [--budget usd] | revert | ui [--port N] [--build] | log | --selftest | --version";

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

async function runCmd(args: string[]) {
  const mt = args.indexOf("--max-turns");
  const maxTurns = mt >= 0 ? parsePositiveIntegerFlag("--max-turns", args.splice(mt, 2)[1]) : 25;
  await run(args[0]!, maxTurns);
}

async function runSubcommand(cmd: string, rest: string[]) {
  if (cmd === "evolve") {
    const { generations, goal, maxTurns, budget } = parseEvolveFlags(rest);
    return evolve(generations, goal, maxTurns, budget);
  }
  if (cmd === "adopt") {
    const { url, ref, budget } = parseAdoptFlags(rest);
    return adopt(url, ref, budget);
  }
  if (cmd === "revert") return revert();
  if (cmd === "log") return printLog();
  if (cmd === "ui") return (await import("./ui/server.ts")).runUiCmd(rest);
  return runCmd([cmd, ...rest]);
}

export async function dispatch(args: string[]) {
  if (DEPTH > 2) { console.error("skynet: nesting depth exceeded"); process.exit(1); }
  if (args[0] === "--version") return console.log(VERSION);
  // --version/--selftest stay outside the try so a failing selftest still prints bun's stack trace
  if (args[0] === "--selftest") return (await import("./selftest.ts")).selftest();
  if (!args[0]) { console.error(USAGE); process.exit(1); }
  try {
    await runSubcommand(args[0], args.slice(1));
  } catch (e) {
    fail(e);
  }
}
