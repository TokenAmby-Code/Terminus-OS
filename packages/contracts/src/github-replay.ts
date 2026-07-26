import { z } from "zod";

const sha = z.string().regex(/^[0-9a-f]{40,64}$/);
const repository = {
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  repository_id: z.number().int().positive(),
  sender: z.string().min(1).nullable(),
};
const pullRequest = {
  pull_request: z.number().int().positive(),
  head_sha: sha,
  head_ref: z.string().min(1),
  base_sha: sha,
  base_ref: z.string().min(1),
};
const app = {
  producer_app_id: z.number().int().positive(),
  producer_app_slug: z.string().min(1),
};

export const GithubNormalizedPayloadSchemas = {
  pull_request: z.object({
    ...repository,
    ...pullRequest,
    action: z.string().min(1),
    merged: z.boolean(),
    merge_sha: sha.nullable(),
  }).strict(),
  pull_request_review: z.object({
    ...repository,
    ...pullRequest,
    action: z.string().min(1),
    review_id: z.number().int().positive(),
    review_state: z.string().min(1),
    review_commit_sha: sha,
  }).strict(),
  pull_request_review_comment: z.object({
    ...repository,
    ...pullRequest,
    action: z.string().min(1),
    comment_id: z.number().int().positive(),
    comment_author: z.string().min(1),
    comment_commit_sha: sha,
  }).strict(),
  issue_comment: z.object({
    ...repository,
    action: z.string().min(1),
    pull_request: z.number().int().positive(),
    comment_id: z.number().int().positive(),
    comment_author: z.string().min(1),
    head_sha: z.null(),
    sha_binding: z.literal("requires_pr_snapshot"),
  }).strict(),
  check_suite: z.object({
    ...repository,
    ...app,
    action: z.string().min(1),
    head_sha: sha,
    status: z.string().min(1),
    conclusion: z.string().min(1).nullable(),
    check_suite_id: z.number().int().positive(),
  }).strict(),
  check_run: z.object({
    ...repository,
    ...app,
    action: z.string().min(1),
    head_sha: sha,
    check_name: z.string().min(1),
    status: z.string().min(1),
    conclusion: z.string().min(1).nullable(),
    check_run_id: z.number().int().positive(),
  }).strict(),
  status: z.object({
    ...repository,
    action: z.null(),
    head_sha: sha,
    check_name: z.string().min(1),
    status: z.string().min(1),
    producer_login: z.string().min(1),
  }).strict(),
  push: z.object({
    ...repository,
    action: z.null(),
    before_sha: sha,
    head_sha: sha,
    ref: z.string().min(1),
  }).strict(),
  create: z.object({
    ...repository,
    action: z.null(),
    ref: z.string().min(1),
    ref_type: z.literal("branch"),
  }).strict(),
  delete: z.object({
    ...repository,
    action: z.null(),
    ref: z.string().min(1),
    ref_type: z.literal("branch"),
  }).strict(),
} as const;

export type GithubWebhookEvent = keyof typeof GithubNormalizedPayloadSchemas;

export function parseGithubNormalizedPayload(event: GithubWebhookEvent, payload: unknown): Record<string, unknown> {
  return GithubNormalizedPayloadSchemas[event].parse(payload) as Record<string, unknown>;
}
