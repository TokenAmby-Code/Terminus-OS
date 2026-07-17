import { describe, expect, test } from "bun:test";
import { mustConfirm, VoiceDirective, voiceProfile, VoiceRole } from "../src/voice.ts";

describe("VC-first voice transport (foundation)", () => {
  test("voice roles are listener and speaker", () => {
    expect(VoiceRole.parse("listener")).toBe("listener");
    expect(VoiceRole.parse("speaker")).toBe("speaker");
    expect(() => VoiceRole.parse("god")).toThrow();
  });

  test("voice profile derives listen/speak from the capability grant", () => {
    expect(voiceProfile(["voice-rx", "voice-tx"])).toEqual({ can_listen: true, can_speak: true });
    expect(voiceProfile(["voice-rx"])).toEqual({ can_listen: true, can_speak: false });
    expect(voiceProfile(["listen", "send"])).toEqual({ can_listen: false, can_speak: false });
  });

  test("a directive defaults to routine risk", () => {
    const d = VoiceDirective.parse({
      transcript: "post status to alerts",
      source_identity: "custodes",
      target_route: "alerts",
    });
    expect(d.risk).toBe("routine");
    expect(mustConfirm(d)).toBe(false);
  });

  test("a destructive directive must be confirmed — voice is never proof for it", () => {
    const d = VoiceDirective.parse({
      transcript: "delete the fleet",
      source_identity: "custodes",
      target_route: "fleet",
      risk: "destructive",
    });
    expect(mustConfirm(d)).toBe(true);
  });
});
