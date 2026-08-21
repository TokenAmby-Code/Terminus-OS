// The comm funnel mouth.
//
// This is the one place a caller-supplied comm identity is allowed to be
// anything other than canonical. It answers a single question — "which
// canonical identity did the caller name?" — and everything downstream of it
// works in canonical terms only. An identity that leaves this module is a
// canonical one, so the event stream records what the estate declares and
// never what the caller happened to type.
//
// Two softenings live here, and only these two:
//
//   Casing. `Custodes`, `COUNCIL:PAX` and `council:pax` name the same thing,
//   and so do `somnium:NE` and `somnium:ne`. No caller has to know how the
//   estate spells its own ids.
//
//   Bare council names. A page-less name that a council seat wears resolves to
//   that seat, so `custodes` addresses `council:custodes`. The roster is the
//   estate's council declaration, so a council seat added there inherits
//   bare-name addressing without this module changing.
//
// A bare name is a sound key only where exactly one seat can hold it. Council
// personas are exclusive by declaration — a council seat's canonical id names
// the one persona it may hold — which is what makes the roster addressable at
// all. A persona several seats wear at once names no single agent, so it is not
// a key and never resolves here.
//
// Casing is folded for COMPARISON and never written back onto the identity.
// Nine declared seat ids carry uppercase — `palace:W` and the somnium compass —
// so an acceptance that lowercased its input would make those seats
// unaddressable by their own canonical id. Softening acceptance may only ever
// widen what reaches a seat.
//
// Softness is not guessing. A bare name the roster does not carry is left
// exactly as the caller sent it, to meet the same loud `identity_absent`
// refusal any other unknown identity meets; a bare name the roster carries
// twice refuses loudly here and names both candidates rather than pick one.

import { TXD_WINDOWS } from './estate.ts';

/** The council seats a bare persona name may address. */
export const COUNCIL_ROSTER: readonly string[] = TXD_WINDOWS.council;

/** The one comparison every identity in this module is judged by. */
export const sameIdentity = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

const bareName = (seatId: string): string => seatId.slice(seatId.indexOf(':') + 1);

export function acceptCommIdentity(raw: string, roster: readonly string[] = COUNCIL_ROSTER): string {
  const seats = roster.filter((seatId) => sameIdentity(bareName(seatId), raw));
  if (seats.length === 0) return raw;
  if (seats.length > 1) {
    throw new Error(`identity_ambiguous: ${raw} — names seats ${seats.join(', ')}; address one by its seat id`);
  }
  return seats[0]!;
}
