import { DEPTH, VERSION } from "./config.ts";
import { run } from "./agent.ts";
import { evolve, revert, parseEvolveFlags, parsePositiveIntegerFlag } from "./evolve.ts";
import { adopt, parseAdoptFlags } from "./adopt.ts";

const USAGE = "usage: bun skynet.ts <git-url|path> [--max-turns N] | evolve [--generations N] [--goal text|url|path] [--max-turns N] [--budget usd] | adopt <git-url> [--ref ref] [--budget usd] | revert | --selftest | --version";

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

async function runCmd(args: string[]) {
  const mt = args.indexOf("--max-turns");
  const maxTurns = mt >= 0 ? parsePositiveIntegerFlag("--max-turns", args.splice(mt, 2)[1]) : 25;
  await run(args[0]!, maxTurns);
}

export async function dispatch(args: string[]) {
  if (DEPTH > 2) { console.error("skynet: nesting depth exceeded"); process.exit(1); }
  if (args[0] === "--version") return console.log(VERSION);
  // --version/--selftest stay outside the try so a failing selftest still prints bun's stack trace
  if (args[0] === "--selftest") return (await import("./selftest.ts")).selftest();
  if (!args[0]) { console.error(USAGE); process.exit(1); }
  try {
    if (args[0] === "evolve") {
      const { generations, goal, maxTurns, budget } = parseEvolveFlags(args.slice(1));
      await evolve(generations, goal, maxTurns, budget);
    } else if (args[0] === "adopt") {
      const { url, ref, budget } = parseAdoptFlags(args.slice(1));
      await adopt(url, ref, budget);
    } else if (args[0] === "revert") await revert();
    else await runCmd(args);
  } catch (e) {
    fail(e);
  }
}
