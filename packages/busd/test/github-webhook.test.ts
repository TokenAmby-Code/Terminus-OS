import { expect, test } from "bun:test";
import { MemoryBusStore } from "../src/store.ts";
import { MemoryReplayStore } from "../src/replay-store.ts";
import { makeServer } from "../src/server.ts";

const delivery = "d9428888-122b-4c26-b269-0a3f62f4f06b";
const secret = new TextEncoder().encode("webhook-test-secret");
// This machine's declared App identity; deliveries carry it in the
// installation-target headers ("one webhook, one persistence machine").
const appId = 4400042;
const appHeaders = {
  "x-github-hook-installation-target-type": "integration",
  "x-github-hook-installation-target-id": String(appId),
};
const payload = JSON.stringify({
  action: "synchronize",
  repository: { id: 42, full_name: "TokenAmby-Code/Token-Fleet" },
  sender: { login: "octocat" },
  pull_request: {
    number: 263,
    merged: false,
    merge_commit_sha: null,
    head: { sha: "a".repeat(40), ref: "feat/replay" },
    base: { sha: "b".repeat(40), ref: "main" },
  },
});

async function signature(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Buffer.from(digest).toString("hex")}`;
}

function fixture() {
  const replayStore = new MemoryReplayStore(() => "2026-07-26T17:00:00.000Z");
  const server = makeServer({
    bind: "127.0.0.1",
    port: 0,
    store: new MemoryBusStore(),
    replayStore,
    onAppend: () => {},
    build: { version: "test", git_sha: "test", bun: Bun.version },
    machine: "test",
    githubWebhookSecret: secret,
    githubWebhookAppId: appId,
    clock: () => "2026-07-26T17:00:00.000Z",
  });
  return { replayStore, server };
}

test("signed GitHub delivery is normalized into one deduplicated replay event", async () => {
  const { replayStore, server } = fixture();
  const headers = {
    ...appHeaders,
    "x-github-delivery": delivery,
    "x-github-event": "pull_request",
    "x-hub-signature-256": await signature(payload),
  };
  try {
    let response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers,
      body: payload,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, created: true, replay_id: delivery });

    const document = JSON.parse(payload) as Record<string, unknown>;
    const reordered = JSON.stringify({
      pull_request: document.pull_request,
      sender: document.sender,
      repository: document.repository,
      action: document.action,
    });
    response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: { ...headers, "x-hub-signature-256": await signature(reordered) },
      body: reordered,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, created: false, replay_id: delivery });

    const projection = await replayStore.projection(delivery);
    expect(projection?.events).toHaveLength(1);
    expect(projection?.events[0]).toMatchObject({
      event_type: "github.pull_request",
      payload: {
        action: "synchronize",
        repository: "TokenAmby-Code/Token-Fleet",
        pull_request: 263,
        head_sha: "a".repeat(40),
        base_sha: "b".repeat(40),
      },
      provenance: { delivery_id: delivery, ingress: "github_webhook", app_id: appId },
    });
  } finally {
    server.stop(true);
  }
});

test("invalid signature and unsupported event refuse before publication", async () => {
  const { replayStore, server } = fixture();
  try {
    let response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": delivery,
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      },
      body: payload,
    });
    expect(response.status).toBe(401);

    response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        ...appHeaders,
        "x-github-delivery": delivery,
        "x-github-event": "fork",
        "x-hub-signature-256": await signature(payload),
      },
      body: payload,
    });
    expect(response.status).toBe(422);
    expect(await replayStore.projection(delivery)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("missing and malformed signatures are unauthorized before publication", async () => {
  const { replayStore, server } = fixture();
  const baseHeaders = {
    "x-github-delivery": delivery,
    "x-github-event": "pull_request",
  };
  try {
    let response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: baseHeaders,
      body: payload,
    });
    expect(response.status).toBe(401);

    response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: { ...baseHeaders, "x-hub-signature-256": "sha256=abcd" },
      body: payload,
    });
    expect(response.status).toBe(401);
    expect(await replayStore.projection(delivery)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("prototype property names are not accepted as GitHub event names", async () => {
  const { replayStore, server } = fixture();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        ...appHeaders,
        "x-github-delivery": delivery,
        "x-github-event": "constructor",
        "x-hub-signature-256": await signature(payload),
      },
      body: payload,
    });
    expect(response.status).toBe(422);
    expect(await replayStore.projection(delivery)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("check producer identity is mandatory and non-PR issue comments are refused", async () => {
  const { replayStore, server } = fixture();
  try {
    const checkPayload = JSON.stringify({
      action: "completed",
      repository: { id: 42, full_name: "TokenAmby-Code/Token-Fleet" },
      sender: { login: "coderrabbitai" },
      check_run: {
        id: 99,
        name: "CodeRabbit",
        head_sha: "a".repeat(40),
        status: "completed",
        conclusion: "success",
      },
    });
    let response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        ...appHeaders,
        "x-github-delivery": delivery,
        "x-github-event": "check_run",
        "x-hub-signature-256": await signature(checkPayload),
      },
      body: checkPayload,
    });
    expect(response.status).toBe(422);

    const commentPayload = JSON.stringify({
      action: "created",
      repository: { id: 42, full_name: "TokenAmby-Code/Token-Fleet" },
      sender: { login: "octocat" },
      issue: { number: 7 },
      comment: { id: 22, user: { login: "octocat" } },
    });
    response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        ...appHeaders,
        "x-github-delivery": crypto.randomUUID(),
        "x-github-event": "issue_comment",
        "x-hub-signature-256": await signature(commentPayload),
      },
      body: commentPayload,
    });
    expect(response.status).toBe(422);
    expect(await replayStore.projection(delivery)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("oversized webhook body is refused before HMAC or publication", async () => {
  const { replayStore, server } = fixture();
  const oversized = "x".repeat(1024 * 1024 + 1);
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": delivery,
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=" + "0".repeat(64),
      },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(await replayStore.projection(delivery)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("review and check facts remain valid when delivered before the PR update", async () => {
  const { replayStore, server } = fixture();
  const reviewDelivery = crypto.randomUUID();
  const checkDelivery = crypto.randomUUID();
  const reviewPayload = JSON.stringify({
    action: "submitted",
    repository: { id: 42, full_name: "TokenAmby-Code/Token-Fleet" },
    sender: { login: "reviewer" },
    pull_request: {
      number: 263,
      head: { sha: "a".repeat(40), ref: "feat/replay" },
      base: { sha: "b".repeat(40), ref: "main" },
    },
    review: { id: 12, state: "approved", commit_id: "a".repeat(40) },
  });
  const checkPayload = JSON.stringify({
    action: "completed",
    repository: { id: 42, full_name: "TokenAmby-Code/Token-Fleet" },
    sender: { login: "coderabbitai" },
    check_run: {
      id: 99,
      name: "CodeRabbit",
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
      app: { id: 777, slug: "coderabbitai" },
    },
  });
  try {
    for (const [event, deliveryId, body] of [
      ["check_run", checkDelivery, checkPayload],
      ["pull_request_review", reviewDelivery, reviewPayload],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
        method: "POST",
        headers: {
          ...appHeaders,
          "x-github-delivery": deliveryId,
          "x-github-event": event,
          "x-hub-signature-256": await signature(body),
        },
        body,
      });
      expect(response.status).toBe(202);
    }
    expect((await replayStore.projection(checkDelivery))?.events[0]?.payload).toMatchObject({
      producer_app_slug: "coderabbitai",
      head_sha: "a".repeat(40),
    });
    expect((await replayStore.projection(reviewDelivery))?.events[0]?.payload).toMatchObject({
      review_state: "approved",
      review_commit_sha: "a".repeat(40),
    });
  } finally {
    server.stop(true);
  }
});

test("a valid PR issue comment is admitted but remains explicitly unbound to a head SHA", async () => {
  const { replayStore, server } = fixture();
  const commentDelivery = crypto.randomUUID();
  const commentPayload = JSON.stringify({
    action: "created",
    repository: { id: 42, full_name: "TokenAmby-Code/Token-Fleet" },
    sender: { login: "octocat" },
    issue: { number: 263, pull_request: { url: "https://api.github.test/pulls/263" } },
    comment: { id: 22, user: { login: "octocat" } },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        ...appHeaders,
        "x-github-delivery": commentDelivery,
        "x-github-event": "issue_comment",
        "x-hub-signature-256": await signature(commentPayload),
      },
      body: commentPayload,
    });
    expect(response.status).toBe(202);
    expect((await replayStore.projection(commentDelivery))?.events[0]?.payload).toMatchObject({
      pull_request: 263,
      comment_author: "octocat",
      head_sha: null,
      sha_binding: "requires_pr_snapshot",
    });
  } finally {
    server.stop(true);
  }
});

// ── App discrimination — "one webhook, one persistence machine" ────────────
// Both fleet Apps can sign with the same shared secret, so a verified
// signature must never admit a foreign App's delivery: same push fact, two
// machines, double admission. A foreign App landing here is a webhook
// misconfiguration and is refused 4xx so GitHub records the failure.

test("a correctly signed delivery from a foreign App is refused 403 before publication", async () => {
  const { replayStore, server } = fixture();
  const baseHeaders = {
    "x-github-delivery": delivery,
    "x-github-event": "pull_request",
    "x-hub-signature-256": await signature(payload),
  };
  const refusals: Record<string, string>[] = [
    // Wrong App id — the other machine's App delivering here.
    { ...baseHeaders, ...appHeaders, "x-github-hook-installation-target-id": String(appId + 1) },
    // Non-numeric target id.
    { ...baseHeaders, ...appHeaders, "x-github-hook-installation-target-id": "not-a-number" },
    // Right id, wrong target type — not a GitHub App webhook at all.
    { ...baseHeaders, ...appHeaders, "x-github-hook-installation-target-type": "repository" },
    // No installation-target identity headers whatsoever.
    baseHeaders,
  ];
  try {
    for (const headers of refusals) {
      const response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
        method: "POST",
        headers,
        body: payload,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: "foreign_github_app",
        expected_app_id: appId,
      });
    }
    expect(await replayStore.projection(delivery)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("a secret without a declared App identity refuses every delivery — no default-open", async () => {
  const replayStore = new MemoryReplayStore(() => "2026-07-26T17:00:00.000Z");
  const server = makeServer({
    bind: "127.0.0.1",
    port: 0,
    store: new MemoryBusStore(),
    replayStore,
    onAppend: () => {},
    build: { version: "test", git_sha: "test", bun: Bun.version },
    machine: "test",
    githubWebhookSecret: secret,
    // githubWebhookAppId deliberately absent.
    clock: () => "2026-07-26T17:00:00.000Z",
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/ingress/github`, {
      method: "POST",
      headers: {
        ...appHeaders,
        "x-github-delivery": delivery,
        "x-github-event": "pull_request",
        "x-hub-signature-256": await signature(payload),
      },
      body: payload,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "github_webhook_unconfigured" });
    expect(await replayStore.projection(delivery)).toBeNull();
  } finally {
    server.stop(true);
  }
});
