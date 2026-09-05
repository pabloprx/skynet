import { existsSync, mkdirSync, readFileSync, appendFileSync } from "fs";
import { HOME, MEMORY } from "./config.ts";

export function recall() {
  return existsSync(MEMORY) ? readFileSync(MEMORY, "utf8") : "";
}
export function learn(repo: string, lesson: string) {
  mkdirSync(HOME, { recursive: true });
  appendFileSync(MEMORY, `- [${new Date().toISOString().slice(0, 10)}] ${repo}: ${lesson.trim()}\n`);
}
