// Test-only probe: scan EVERY string in a structure for a raw tmux id.
//
// This deliberately does not live on the module's exported surface. Judging
// content this way is the defect `ids.ts` was corrected for, and an export with
// no runtime caller invites the next reader to believe there is a live path.
//
// It survives here because a test is the one place the stronger claim is the
// useful one: a refusal must not echo the offending id back ANYWHERE, prose
// included. That is an assertion about our output, not a rule about callers.
import { findTmuxId } from '../src/ids.ts';

export function findTmuxIdDeep(value: unknown, path = '$'): string | null {
  if (typeof value === 'string') return findTmuxId(value) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findTmuxIdDeep(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (findTmuxId(k)) return `${path}.* (key)`;
      const hit = findTmuxIdDeep(v, `${path}.${k}`);
      if (hit) return hit;
    }
  }
  return null;
}
