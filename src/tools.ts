// guard the tool-call boundary: model-provided tool arguments are untrusted, so parse
// defensively and return { error } instead of letting one malformed call crash the whole
// repair/evolve run.
export function parseToolCmd(raw: string): { cmd: string } | { error: string } {
  try {
    const parsed = JSON.parse(raw) as { cmd?: unknown };
    if (typeof parsed?.cmd !== "string") return { error: "missing or non-string cmd" };
    return { cmd: parsed.cmd };
  } catch {
    return { error: "invalid JSON" };
  }
}

// ponytail: heuristic denylist (dir escape, .env, sudo, recursive evolve), not a sandbox.
// Real containment needs bwrap/firejail/chroot if this matters more. The recursive-evolve
// clause is belt-and-braces on top of the SKYNET_CHILD guard in evolve()/run().
export function isBlockedCmd(cmd: string): boolean {
  return /(^|[\s;&|])cd\s+(\.\.|~|\/)|\.env\b|\bsudo\b|skynet\.ts\s+evolve\b/.test(cmd);
}
