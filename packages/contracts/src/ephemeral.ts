import { z } from "zod";

/**
 * Temporary ephemeral-channel capability policy.
 *
 * Terminus-OS owns this state even though it does not yet own a daemon/runtime path that can
 * enforce it. Consumers must fail loudly with the exact envelope below. They must not convert
 * the disabled state into success, a no-op, an automatic reprompt, or an automatic retry.
 *
 * Revival is a deliberate contract replacement, not a relaxation of this schema. Before a
 * replacement state can ship, the parked canonical instance-id resolution fix must be
 * implemented in the delivery path.
 */

export const EPHEMERAL_CHANNEL_AVAILABILITY = "temporarily_disabled" as const;
export const EPHEMERAL_CHANNEL_ERROR_CODE =
  "ephemeral_channel_temporarily_disabled" as const;
export const EPHEMERAL_CHANNEL_ERROR_MESSAGE =
  "ephemeral channel disabled by decree" as const;

export const EphemeralChannelDisabledError = z.strictObject({
  code: z.literal(EPHEMERAL_CHANNEL_ERROR_CODE),
  message: z.literal(EPHEMERAL_CHANNEL_ERROR_MESSAGE),
});
export type EphemeralChannelDisabledErrorT = z.infer<typeof EphemeralChannelDisabledError>;

export const EphemeralChannelContract = z.strictObject({
  availability: z.literal(EPHEMERAL_CHANNEL_AVAILABILITY),
  error: EphemeralChannelDisabledError,
  automatic_reprompt: z.literal(false),
  automatic_retry: z.literal(false),
});
export type EphemeralChannelContractT = z.infer<typeof EphemeralChannelContract>;

export const EPHEMERAL_CHANNEL_CONTRACT = {
  availability: EPHEMERAL_CHANNEL_AVAILABILITY,
  error: {
    code: EPHEMERAL_CHANNEL_ERROR_CODE,
    message: EPHEMERAL_CHANNEL_ERROR_MESSAGE,
  },
  automatic_reprompt: false,
  automatic_retry: false,
} as const satisfies EphemeralChannelContractT;

/** The only valid response while the temporary disablement is active. */
export const EphemeralChannelDisabledEnvelope = z.strictObject({
  ok: z.literal(false),
  error: EphemeralChannelDisabledError,
});
export type EphemeralChannelDisabledEnvelopeT = z.infer<
  typeof EphemeralChannelDisabledEnvelope
>;

export const EPHEMERAL_CHANNEL_DISABLED_ENVELOPE = {
  ok: false,
  error: EPHEMERAL_CHANNEL_CONTRACT.error,
} as const satisfies EphemeralChannelDisabledEnvelopeT;
