import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IDENTITY_DECLARATIONS,
  IdentityDeclaration,
  IdentityId,
  RESERVED_IDENTITIES,
  TENANT_IDENTITIES,
} from "../src/identity.ts";
import { hasVoice } from "../src/capability.ts";

describe("tenant identities (foundation)", () => {
  test("the tenant runs exactly Custodes and Guard", () => {
    expect([...TENANT_IDENTITIES].sort()).toEqual(["custodes", "guard"]);
    expect(IdentityId.parse("custodes")).toBe("custodes");
  });

  test("Mechanicus is reserved but NOT a tenant identity (least-privilege app pending)", () => {
    expect([...RESERVED_IDENTITIES]).toContain("mechanicus");
    expect(() => IdentityId.parse("mechanicus")).toThrow();
  });

  test("each default declaration is a valid, secret-free declaration", () => {
    for (const decl of Object.values(DEFAULT_IDENTITY_DECLARATIONS)) {
      expect(() => IdentityDeclaration.parse(decl)).not.toThrow();
      // The declaration carries env var NAMES, never values — safe in source.
      expect(decl.token_env.startsWith("TERMINUS_DISCORD_")).toBe(true);
      expect(decl.application_id_env.startsWith("TERMINUS_DISCORD_")).toBe(true);
    }
  });

  test("capability policy: Custodes carries voice, Guard is text-only", () => {
    expect(hasVoice(DEFAULT_IDENTITY_DECLARATIONS.custodes.capabilities)).toBe(true);
    expect(hasVoice(DEFAULT_IDENTITY_DECLARATIONS.guard.capabilities)).toBe(false);
    expect([...DEFAULT_IDENTITY_DECLARATIONS.guard.capabilities].sort()).toEqual(["listen", "send"]);
  });
});
