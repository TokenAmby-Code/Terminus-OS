import { z } from "zod";

/**
 * The tmuxctld loopback daemon speaks a uniform ok/error envelope. Every op
 * returns either `{ ok: true, result }` or `{ ok: false, error }`.
 *
 * Live specimens (2026-07-16):
 *   ok:    {"ok":true,"result":[ ... ]}
 *   error: {"ok":false,"error":{"code":"ValueError",
 *           "message":"wrapper ledger occupancy lookup failed for council:pax","detail":""}}
 *
 * Note the fail-loud specimen: `detail` is present-but-empty ("") in the wild, so it is a
 * required string, not optional. `code` mirrors the Python exception class name ("ValueError").
 */
export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  detail: z.string(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

export const ErrorEnvelope = z.object({
  ok: z.literal(false),
  error: ErrorBody,
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;

/** Success half of the envelope, parameterised over the op's `result` schema. */
export function okEnvelope<T extends z.ZodTypeAny>(result: T) {
  return z.object({ ok: z.literal(true), result });
}

/**
 * A full op envelope: discriminated on `ok`. Parse any tmuxctld op response through
 * `envelope(<ResultSchema>)` and narrow on `.ok`.
 */
export function envelope<T extends z.ZodTypeAny>(result: T) {
  return z.discriminatedUnion("ok", [okEnvelope(result), ErrorEnvelope]);
}

export type OkEnvelope<T> = { ok: true; result: T };
export type Envelope<T> = OkEnvelope<T> | ErrorEnvelope;
