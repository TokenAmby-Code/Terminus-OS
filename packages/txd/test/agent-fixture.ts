// Canonical UUID-shaped birth ticket used by the agent-contract adoption
// fixtures. It is an Agent field only; these tests never fabricate a ticketd
// receipt or teach txd anything about ticket assignment.
export const AGENT_TICKET_ID = '33333333-3333-4333-8333-333333333333';

// The instant the driving fact reports. Production threads the journal event's
// or the lifecycle fact's own `occurred_at` into every txd publication, so a
// test that calls the daemon directly names an instant the same way.
export const DRIVING_FACT_OCCURRED_AT = '2026-09-09T20:41:59.419-07:00';
