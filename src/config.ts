import { join, resolve } from "path";

export const HOME = process.env.SKYNET_HOME ?? join(process.env.HOME!, ".skynet");
export const MEMORY = join(HOME, "memory.md");
export const WORK = join(HOME, "work");
export const MODEL = process.env.SKYNET_MODEL ?? "z-ai/glm-5.3-flash";
export const VERSION = "0.1.0";
// every place skynet spawns another skynet.ts process passes SKYNET_DEPTH=DEPTH+1; startup refuses
// once it exceeds 2, so a recursion bug in gate()/agentLoop/evolve can no longer fork-bomb the box.
export const DEPTH = Number(process.env.SKYNET_DEPTH ?? "0");
// repo root: import.meta.dir here is src/, and every self-spawn must address <root>/skynet.ts
export const ROOT = resolve(import.meta.dir, "..");
