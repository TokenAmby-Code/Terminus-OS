import { z } from "zod";
import type { CapabilityT } from "./capability.ts";

/**
 * VC-FIRST: voice is the headline capability. It is an OPERATOR-INPUT TRANSPORT, not an
 * authority. A voice capability maps to exactly one voice role:
 *   voice-rx → listener (receive operator audio)
 *   voice-tx → speaker  (TTS playback into the channel)
 *
 * The transport carries intent; it never proves it. Before acting on a transcript the tenant
 * must verify the transcript text, the source identity, and the target routing, and any
 * destructive or high-risk directive requires confirmation through an authoritative channel
 * (the skill: "Do not treat voice transcripts as proof for destructive actions"). That
 * invariant is modelled here so it cannot be forgotten at a call site.
 */

export const VOICE_ROLES = ["listener", "speaker"] as const;
export const VoiceRole = z.enum(VOICE_ROLES);
export type VoiceRoleT = z.infer<typeof VoiceRole>;

/** The voice posture derived from a capability grant. Both false = the identity is voice-inert. */
export interface VoiceProfile {
  can_listen: boolean;
  can_speak: boolean;
}

export function voiceProfile(caps: readonly CapabilityT[]): VoiceProfile {
  return {
    can_listen: caps.includes("voice-rx"),
    can_speak: caps.includes("voice-tx"),
  };
}

/**
 * A directive lifted from a voice transcript. `risk` defaults to "routine"; a caller that
 * cannot positively establish a directive is routine MUST classify it "destructive" — the
 * safe default is confirmation, never action.
 */
export const RISK_LEVELS = ["routine", "destructive"] as const;
export const RiskLevel = z.enum(RISK_LEVELS);
export type RiskLevelT = z.infer<typeof RiskLevel>;

export const VoiceDirective = z.object({
  transcript: z.string(),
  source_identity: z.string().min(1),
  target_route: z.string().min(1),
  risk: RiskLevel.default("routine"),
});
export type VoiceDirectiveT = z.infer<typeof VoiceDirective>;

/**
 * The single gate: a destructive directive must be confirmed through an authoritative channel
 * before the tenant acts on it. Voice alone is never sufficient authority for a destructive act.
 */
export function mustConfirm(directive: VoiceDirectiveT): boolean {
  return directive.risk === "destructive";
}
