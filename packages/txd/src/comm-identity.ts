// The comm funnel mouth.
//
// This is the one place a caller-supplied comm identity is allowed to be
// anything other than canonical. It answers a single question — "which
// canonical identity did the caller name?" — and everything downstream of it
// works in canonical terms only: lowercase, and page-qualified for a seat. An
// identity that leaves this function is the identity the event stream records.
//
// Two softenings live here, and only these two:
//
//   Casing. `Custodes`, `COUNCIL:PAX` and `council:pax` name the same thing.
//   No caller has to know how the estate spells its own ids.
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
// Softness is not guessing. A bare name the roster does not carry is returned
// untouched, to meet the same loud `identity_absent` refusal any other unknown
// identity meets; a bare name the roster carries twice refuses loudly here and
// names both candidates rather than pick one.

import { TXD_WINDOWS } from './estate.ts';

/** The council seats a bare persona name may address. */
export const COUNCIL_ROSTER: readonly string[] = TXD_WINDOWS.council;

const bareName = (seatId: string): string => seatId.slice(seatId.indexOf(':') + 1);

export function acceptCommIdentity(raw: string, roster: readonly string[] = COUNCIL_ROSTER): string {
  const identity = raw.toLowerCase();
  const seats = roster.filter((seatId) => bareName(seatId) === identity);
  if (seats.length === 0) return identity;
  if (seats.length > 1) {
    throw new Error(`identity_ambiguous: ${identity} — names seats ${seats.join(', ')}; address one by its seat id`);
  }
  return seats[0]!;
}
