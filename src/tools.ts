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
// git remote/.git-config are blocked too: the child's own clone metadata would otherwise
// hand back ROOT's absolute host path (see the origin-remote removal in evolve.ts's
// prepareChild, which closes the other half of this — the value isn't there to read either).
export function isBlockedCmd(cmd: string): boolean {
  return /(^|[\s;&|])cd\s+(\.\.|~|\/)|\.env\b|\bsudo\b|skynet\.ts\s+evolve\b|\.git\/config\b|\bgit\s+remote\b/.test(cmd);
}
