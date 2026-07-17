import { describe, expect, test } from "bun:test";
import {
  CAPABILITIES,
  Capability,
  CapabilityGrant,
  grants,
  hasVoice,
} from "../src/capability.ts";

describe("capability vocabulary (foundation)", () => {
  test("the five capabilities are listen | send | slash | voice-rx | voice-tx", () => {
    expect([...CAPABILITIES].sort()).toEqual(["listen", "send", "slash", "voice-rx", "voice-tx"]);
    expect(Capability.parse("voice-rx")).toBe("voice-rx");
    expect(() => Capability.parse("admin")).toThrow();
  });

  test("a grant deduplicates and rejects unknown capabilities", () => {
    expect(CapabilityGrant.parse(["send", "send", "listen"])).toEqual(["send", "listen"]);
    expect(() => CapabilityGrant.parse(["send", "root"])).toThrow();
  });

  test("hasVoice is true for either voice capability, false otherwise", () => {
    expect(hasVoice(["voice-rx"])).toBe(true);
    expect(hasVoice(["voice-tx"])).toBe(true);
    expect(hasVoice(["listen", "send", "slash"])).toBe(false);
    expect(hasVoice([])).toBe(false);
  });

  test("grants is the single privilege check — never inferred from a name", () => {
    expect(grants(["send", "listen"], "send")).toBe(true);
    expect(grants(["listen"], "send")).toBe(false);
  });
});
