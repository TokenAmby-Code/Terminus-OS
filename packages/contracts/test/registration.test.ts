import { describe, expect, test } from "bun:test";
import { AGENT_SCHEMA_VERSION, AgentSchema } from "@tokenamby-code/agent-contract/agent";
import { WrapperStartHookSchema } from "@tokenamby-code/agent-contract/agent";
import { RegistrationPreparedSchema } from "@tokenamby-code/agent-contract/events";

const AGENT_ID = "2ea2d049-0106-4957-8649-31f93bdc8c9a";
const TICKET_ID = "33333333-3333-4333-8333-333333333333";
const BIRTH_GENERATION = "1cc2112c-9c38-45a1-839f-831c33a1096a";
const PANE_GENERATION = "786b72b2-58d5-4294-8f95-928289984d6f";
const DIGEST = "a".repeat(64);

describe("registrationd Agent package contract", () => {
  test("parses the complete authoritative snapshot", () => {
    const agent = AgentSchema.parse({
      schema_version: 8,
      ticket_id: TICKET_ID,
      identity: `astartes:unassigned:${AGENT_ID}`,
      incarnation: { agent_id: AGENT_ID, birth_generation: BIRTH_GENERATION },
      registered_at: "2026-07-29T12:00:00.000Z",
      engine: "codex",
      launch: { argv: [], requested_cwd: "/work" },
      placement: {
        pane_id: "palace:worker-1",
        pane_generation: PANE_GENERATION,
        machine: "k12-personal",
        kind: "local",
        wrapper_pid: 101,
        transport_witnesses: {},
      },
      configuration: { generation: "estate-4", digest: DIGEST },
      persona: null,
      resources: [],
    });
    expect(AGENT_SCHEMA_VERSION).toBe(8);
    expect(agent.ticket_id).toBe(TICKET_ID);
    expect(agent.incarnation.agent_id).toBe(AGENT_ID);
  });

  test("refuses a version 8 Agent without its birth ticket", () => {
    expect(AgentSchema.safeParse({
      schema_version: 8,
      identity: `astartes:unassigned:${AGENT_ID}`,
      incarnation: { agent_id: AGENT_ID, birth_generation: BIRTH_GENERATION },
      registered_at: "2026-07-29T12:00:00.000Z",
      engine: "codex",
      launch: { argv: [], requested_cwd: "/work" },
      placement: {
        pane_id: "palace:worker-1",
        pane_generation: PANE_GENERATION,
        machine: "k12-personal",
        kind: "local",
        wrapper_pid: 101,
        transport_witnesses: {},
      },
      configuration: { generation: "estate-4", digest: DIGEST },
      persona: null,
      resources: [],
    }).success).toBe(false);
  });

  test("claims exist only in wrapper evidence, never the final Agent", () => {
    expect(WrapperStartHookSchema.parse({
      hook_request_id: AGENT_ID,
      engine: "claude",
      cwd: "/work",
      machine: "k12-personal",
      wrapper_pid: 101,
      claimed_pane_id: "palace:worker-1",
      argv: [],
      placement_hints: {},
    }).claimed_pane_id).toBe("palace:worker-1");
    expect(RegistrationPreparedSchema.safeParse({ claimed_pane_id: "forged" }).success).toBe(false);
  });
});
