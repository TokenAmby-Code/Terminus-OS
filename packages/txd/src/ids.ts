// Canonical-id membrane (spec §7 rung 2).
//
// Canonical ids (seat names like `somnium:NE`) are the ONLY id surface the
// daemon exposes. Raw tmux ids — pane `%N`, window `@N`, session `$N` — live
// strictly BELOW the tmux control plane and must never appear in an API
// response, a log line, or an event payload. This module is the guard that
// makes that invariant testable: the control plane translates at the membrane,
// and `assertNoTmuxIdInIdentifiers` fails loud if an IDENTIFIER leaks upward.

// tmux id sigils followed by digits: `%5` (pane), `@5` (window), `$5` (session).
// Match the sigil+digits shape anywhere in a string. Canonical ids
// (`somnium:NE`, `palace:W`) do not use these below-membrane sigils.
const TMUX_ID_PATTERN = /([%@$]\d+)\b/;
const TMUX_ID_PATTERN_GLOBAL = /[%@$]\d+\b/g;

export function findTmuxId(text: string): string | null {
  const m = TMUX_ID_PATTERN.exec(text);
  return m ? m[1]! : null;
}


/** Redact below-membrane identifiers before an error reaches structured logs. */
export function sanitizeTmuxIds(text: string): string {
  return text.replace(TMUX_ID_PATTERN_GLOBAL, '[tmux-id]');
}

/**
 * The keys that carry an ESTATE IDENTIFIER. This set is the membrane's
 * structural basis: it is declared, greppable and reviewable, rather than a
 * scan that guesses from shape.
 *
 * Everything NOT named here is data — a comm body, an agent's reply, a stop
 * hook's last message, a command line, a digest — and is never judged. Prose
 * that happens to contain `%28` or `zod@4.4` is prose; only a field that claims
 * to be an identifier can leak one.
 */
const IDENTIFIER_KEYS = new Set([
  'entity_id',
  'agent_id',
  'source_agent_id',
  'target_agent_id',
  'subscriber_agent_id',
  'seat_id',
  'seat',
  'seats',
  'bound_seats',
  'pane',
  'pane_id',
  'claimed_pane_id',
  'page',
  'target',
  'targets',
  'dispatch_target',
  // An opaque edge-proxy receipt. It identifies a transport interaction and
  // never carries caller prose, so judging it costs nothing and keeps a
  // protection that was written deliberately.
  'transport_receipt',
]);

function findTmuxIdInValue(value: unknown, path: string): string | null {
  if (typeof value === 'string') return findTmuxId(value) ? path : null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findTmuxIdInValue(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Scan only the IDENTIFIER-bearing fields of a structure, at any depth. Objects
 * and arrays are still walked so a nested identifier cannot hide, but a string
 * is only ever tested when the key that holds it declares itself an identifier.
 */
export function findTmuxIdInIdentifiers(value: unknown, path = '$'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findTmuxIdInIdentifiers(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // A KEY is structure, never prose. An object keyed by a raw tmux id has
      // leaked one into its shape, so keys stay judged unconditionally.
      if (findTmuxId(k)) return `${path}.* (key)`;
      if (IDENTIFIER_KEYS.has(k)) {
        const hit = findTmuxIdInValue(v, `${path}.${k}`);
        if (hit) return hit;
      }
      const nested = findTmuxIdInIdentifiers(v, `${path}.${k}`);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * The leak-upward invariant, unchanged in DIRECTION and narrowed in SUBJECT.
 *
 * txd must never expose a raw tmux id as an identifier — in a response, a log
 * line or an event payload. That protection is intact. What changed is what it
 * judges: it used to scan every string it could reach, which meant a message
 * body quoting a pane id was treated as txd leaking one. It now judges the
 * fields that claim to be identifiers, and nothing else.
 */
export function assertNoTmuxIdInIdentifiers(value: unknown, where: string): void {
  const leak = findTmuxIdInIdentifiers(value);
  if (leak) {
    throw new Error(`txd canonical-id breach: raw tmux id leaked at ${where} (${leak})`);
  }
}
