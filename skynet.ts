#!/usr/bin/env bun
// skynet: clone a repo, run its tests, let an LLM repair failures, remember what it learned.
//   bun skynet.ts <git-url|path> [--max-turns N]
//   bun skynet.ts evolve [--generations N] [--goal "text|url|path"] [--max-turns N] [--budget usd]
//   bun skynet.ts adopt <git-url> [--ref ref] [--budget usd]
//   bun skynet.ts revert
//   bun skynet.ts --selftest
//   bun skynet.ts --version
// thin entry: code lives in src/, this file stays at the repo root because every self-spawn addresses it.
export * from "./src/config.ts";
export * from "./src/shell.ts";
export * from "./src/memory.ts";
export * from "./src/tools.ts";
export * from "./src/agent.ts";
export * from "./src/gate.ts";
export * from "./src/evolve.ts";
export * from "./src/adopt.ts";
export * from "./src/cli.ts";
import { dispatch } from "./src/cli.ts";
if (import.meta.main) await dispatch(process.argv.slice(2));
