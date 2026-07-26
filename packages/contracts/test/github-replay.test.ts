import { describe, expect, test } from "bun:test";
import { parseGithubNormalizedPayload } from "../src/github-replay.ts";

const common = {
  repository: "TokenAmby-Code/Token-Fleet",
  repository_id: 42,
  sender: "octocat",
};

describe("normalized GitHub replay facts", () => {
  test("required checks bind producer App identity and exact head SHA", () => {
    expect(parseGithubNormalizedPayload("check_run", {
      ...common,
      action: "completed",
      producer_app_id: 777,
      producer_app_slug: "coderabbitai",
      head_sha: "a".repeat(40),
      check_name: "CodeRabbit",
      status: "completed",
      conclusion: "success",
      check_run_id: 99,
    })).toMatchObject({
      producer_app_slug: "coderabbitai",
      head_sha: "a".repeat(40),
    });
    expect(() => parseGithubNormalizedPayload("check_run", {
      ...common,
      action: "completed",
      head_sha: "a".repeat(40),
      check_name: "CodeRabbit",
      status: "completed",
      conclusion: "success",
      check_run_id: 99,
    })).toThrow();
  });

  test("issue comments cannot claim a head SHA", () => {
    expect(() => parseGithubNormalizedPayload("issue_comment", {
      ...common,
      action: "created",
      pull_request: 7,
      comment_id: 8,
      comment_author: "octocat",
      head_sha: "a".repeat(40),
      sha_binding: "requires_pr_snapshot",
    })).toThrow();
  });
});
