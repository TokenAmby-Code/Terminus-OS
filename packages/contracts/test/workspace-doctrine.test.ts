import { expect, test } from "bun:test";
import {
  AGENT_SCHEMA_VERSION,
  DispatchRequestedSchema,
  PaneAttestedSchema,
} from "../src/registration.ts";

const worktree = {
  repository: "token-fleet",
  branch: "feat/workspace-doctrine",
  replay_id: "832e7e1f-76e5-458d-8af7-a6af1798017b",
  path: "/var/lib/githubd/worktrees/token-fleet/feat-workspace-doctrine",
  head_sha: "b".repeat(40),
};

test("dispatch and pane attestation carry the same githubd worktree", () => {
  const dispatch = DispatchRequestedSchema.parse({
    schema_version: AGENT_SCHEMA_VERSION,
    dispatch_id: "d1d1d1d1-0000-4000-8000-000000000001",
    agent_id: "7c1d2f60-3a4b-4c5d-8e9f-0a1b2c3d4e5f",
    machine: "k12-personal",
    target: { kind: "seat", seat_id: "palace:W" },
    engine: "codex",
    worktree,
  });
  expect(dispatch.worktree).toEqual(worktree);

  const pane = PaneAttestedSchema.parse({
    hook_request_id: "2ea2d049-0106-4957-8649-31f93bdc8c9a",
    claimed_pane_id: "palace:W",
    pane_id: "palace:W",
    pane_generation: "786b72b2-58d5-4294-8f95-928289984d6f",
    machine: "k12-personal",
    kind: "local",
    agent_id: dispatch.agent_id,
    wrapper_pid: 101,
    configuration: { generation: "estate-1", digest: "a".repeat(64) },
    worktree,
    process_witnesses: {},
  });
  expect(pane.worktree).toEqual(dispatch.worktree!);
});
