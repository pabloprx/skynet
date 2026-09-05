import { sh } from "./shell.ts";
import { learn } from "./memory.ts";
import { gate } from "./gate.ts";
import { prepareChild, promote, parseBudgetFlag, takeFlagValue } from "./evolve.ts";
import { appendTrace, traceDir } from "./trace.ts";
import { maybeStartUi } from "./ui/server.ts";

// ---------- adopt: pull another skynet's code through the same gate ----------
export function parseAdoptFlags(argv: string[]) {
  const flags = [...argv];
  const url = flags.shift();
  if (!url) throw new Error("adopt requires a git-url");
  const noUi = flags.includes("--no-ui");
  if (noUi) flags.splice(flags.indexOf("--no-ui"), 1);
  const ref = takeFlagValue(flags, "--ref") ?? "main";
  return { url, ref, budget: parseBudgetFlag(flags), noUi };
}

// ponytail: budget is accepted for CLI parity with evolve but unused - adopt makes no LLM call
// (cost is 0 unless SKYNET_REVIEW_MODEL is set, and gate()'s diff review isn't budget-metered
// for evolve either). Add real metering here if a paid review model regularly runs on adopt.
export async function adopt(url: string, ref: string, _budget: number, noUi = false) {
  if (process.env.SKYNET_CHILD) throw new Error("adopt: refusing to run recursively inside a child (SKYNET_CHILD is set)");
  maybeStartUi(!noUi);
  const { n, child } = await prepareChild();

  const goal = `adopt ${url}`;
  // prepareChild() already wrote this generation's "start" event (with pid) - just record the goal.
  appendTrace(n, "goal", { goal });
  appendTrace(n, "stage", { stage: "merge" });
  const beforeSha = (await sh("git rev-parse HEAD", child)).text.trim();
  const pull = await sh(`git pull --no-ff --no-edit ${JSON.stringify(url)} ${JSON.stringify(ref)}`, child, 120_000);

  let gateResult: { ok: boolean; reason: string };
  if (pull.code !== 0) {
    await sh("git merge --abort", child);
    gateResult = { ok: false, reason: "merge conflict" };
  } else {
    // git pull --no-ff commits the merge immediately, but gate()'s checks read the *uncommitted*
    // diff (built for evolve's uncommitted-edit flow) - reset back to expose the merge as an
    // unstaged diff, same shape gate() already expects, then re-commit once it passes below.
    const afterSha = (await sh("git rev-parse HEAD", child)).text.trim();
    if (afterSha !== beforeSha) await sh(`git reset ${beforeSha}`, child);
    appendTrace(n, "stage", { stage: "gate" });
    gateResult = await gate(child, n, goal, traceDir());
  }

  if (gateResult.ok) {
    appendTrace(n, "stage", { stage: "promote" });
    await promote(child, n, goal);
    learn("self", `gen ${n} adopted: ${goal}`);
    console.log(`gen ${n} adopted.`);
    appendTrace(n, "promoted", { cost: 0 });
  } else {
    learn("self", `gen ${n} adopt rejected: ${goal}: ${gateResult.reason}`);
    console.log(`gen ${n} adopt rejected (${gateResult.reason}), left at ${child} for inspection.`);
    appendTrace(n, "rejected", { reason: gateResult.reason, cost: 0 });
  }
}
