// Behavioral pin on the mirrored Agent contract: the persona package carries
// its voice — a synth voice_identity for speaking personas, null for silent
// ones — and the contract speaks schema 4.
import { describe, expect, test } from "bun:test";
import {
  AGENT_SCHEMA_VERSION,
  AgentRetiredSchema,
  PersonaPackageSchema,
  RegistrationAbortedSchema,
} from "../src/registration.ts";

const AGENT_ID = "2ea2d049-0106-4957-8649-31f93bdc8c9a";
const BIRTH_GENERATION = "1cc2112c-9c38-45a1-839f-831c33a1096a";
const PANE_GENERATION = "786b72b2-58d5-4294-8f95-928289984d6f";

const personaPackage = (voice: string | null) => ({
  persona: "custodes",
  rank: "overseer",
  commander: null,
  tint: "#302800",
  voice,
  workspace: "/personas/custodes",
  continuity_references: [],
  instruction_package: {
    digest: "b".repeat(64),
    sources: [],
    rendered_path: "/personas/custodes/CLAUDE.md",
  },
});

describe("persona voice in the mirrored contract", () => {
  test("a speaking persona carries its synth voice identity", () => {
    expect(PersonaPackageSchema.parse(personaPackage("fable")).voice).toBe("fable");
  });

  test("a silent persona carries voice null", () => {
    expect(PersonaPackageSchema.parse(personaPackage(null)).voice).toBeNull();
  });

  test("a package that declares no voice at all does not parse", () => {
    const { voice: _voice, ...silentByOmission } = personaPackage(null);
    expect(PersonaPackageSchema.safeParse(silentByOmission).success).toBe(false);
  });
});

describe("agent schema version in the mirrored contract", () => {
  test("the mirror speaks schema 4", () => {
    expect(AGENT_SCHEMA_VERSION).toBe(5);
  });

  test("agent.retired is pinned to schema 4 and schema 3 stays dead", () => {
    const retired = {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: AGENT_ID,
      birth_generation: BIRTH_GENERATION,
      seat_id: "palace:W",
      pane_generation: PANE_GENERATION,
      machine: "k12-personal",
      cause: "close",
      retired_at: "2026-08-01T12:00:00.000Z",
    };
    expect(AgentRetiredSchema.parse(retired).schema_version).toBe(5);
    expect(AgentRetiredSchema.safeParse({ ...retired, schema_version: 3 }).success).toBe(false);
  });

  test("registration_aborted is pinned to schema 4 and schema 3 stays dead", () => {
    const aborted = {
      schema_version: AGENT_SCHEMA_VERSION,
      agent_id: AGENT_ID,
      birth_generation: BIRTH_GENERATION,
      pane_id: null,
      pane_generation: null,
      persona: null,
      reason: "pane_refused",
      aborted_at: "2026-08-01T12:00:00.000Z",
    };
    expect(RegistrationAbortedSchema.parse(aborted).schema_version).toBe(5);
    expect(RegistrationAbortedSchema.safeParse({ ...aborted, schema_version: 3 }).success).toBe(false);
  });
});
