import { z } from "zod";

/**
 * Bot behavior is CAPABILITY-DRIVEN. An identity does exactly what its declared capabilities
 * allow; the identity id grants nothing (the skill: "identity names do not imply privilege").
 * Privilege is never inferred from a name — the recon's per-bot fragility all descended from
 * name-based coupling, so it is banned at the type level here.
 *
 * The five capabilities are the whole vocabulary of the tenant:
 *   listen   — ingest text messages from subscribed channels.
 *   send     — post text to a channel (the notification-router sink rides this).
 *   slash    — register and serve application (slash) commands.
 *   voice-rx — join a voice channel and receive operator audio (the headline capability).
 *   voice-tx — speak into a voice channel (TTS playback).
 *
 * Text = the device-agnostic notification router (`listen`/`send`); voice = the operator-input
 * transport (`voice-rx`/`voice-tx`). A grant is explicit, per identity, in the declaration
 * table (../identity.ts) — never derived from the identity id.
 */
export const CAPABILITIES = ["listen", "send", "slash", "voice-rx", "voice-tx"] as const;
export const Capability = z.enum(CAPABILITIES);
export type CapabilityT = z.infer<typeof Capability>;

/**
 * A declared capability grant: parsed from the enum and deduplicated. Order-insensitive; an
 * empty grant is a legal (inert) identity that connects but is authorised for nothing.
 */
export const CapabilityGrant = z.array(Capability).transform((caps) => [...new Set(caps)]);
export type CapabilityGrantT = z.infer<typeof CapabilityGrant>;

/** The two voice capabilities. voice-rx = listener, voice-tx = speaker (see ../voice.ts). */
export const VOICE_CAPABILITIES = ["voice-rx", "voice-tx"] as const;

/** True when a grant carries any voice capability — gates the voice/OpenAI credential. */
export function hasVoice(caps: readonly CapabilityT[]): boolean {
  return caps.some((c) => c === "voice-rx" || c === "voice-tx");
}

/** True when a grant carries a specific capability. The single authority for a privilege check. */
export function grants(caps: readonly CapabilityT[], capability: CapabilityT): boolean {
  return caps.includes(capability);
}
