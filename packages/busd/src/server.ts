// HTTP surface — busd's three planes (txd route-table idiom: the table stays
// exported data so committed route tests can pin the surface exactly):
//
//   /ctl/*             daemon ops (health + per-subscription lag)
//   /ingress/hooks/*   the hook shim door: one endpoint per pinned vendor hook
//                      type, ALL consumed — each POST journals a `hook.<type>`
//                      bus event. There is NO 410 tail: on the central bus no
//                      hook type evaporates (the old per-consumer 410
//                      invariant is dead; consumers subscribe instead).
//   /ingress/events    the generic publish door for loopback emitters. The
//                      `hook.*` namespace is reserved and rejected here so a
//                      synthetic hook can never be forged past the shim.
//
// Ingress is loopback: harness hooks arrive via the local edge proxy (the
// `x-edge-proxy` header is the transport receipt woven into provenance);
// future emitters POST /ingress/events directly. If the database is down,
// appends throw and the doors 5xx — busd has NO fallback path by ruling
// (adapters are fail-open; the proxy logs the partial broadcast).

import {
  BUS_SCHEMA_VERSION,
  BusPublishRequestSchema,
  HOOK_TYPES,
  ReplayAdmissionSchema,
  ReplayAppendSchema,
  parseGithubNormalizedPayload,
  type GithubWebhookEvent,
  type BusHealth,
} from '@terminus-os/contracts';
import type { BusStore, Clock } from './store.ts';
import {
  EventIdentityConflict,
  IdempotencyConflict,
  InvalidEventCursor,
  UnknownReplay,
  type ReplayStore,
} from './replay-store.ts';

export type BuildInfo = { version: string; git_sha: string; bun: string };

export type Route = {
  method: string;
  /** Exact match, or a matcher returning captured params (null = no match). */
  match: (pathname: string) => Record<string, string> | null;
  label: string;
  handler: (req: Request, params: Record<string, string>) => Promise<Response>;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function exact(path: string) {
  return (pathname: string) => (pathname === path ? {} : null);
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function receipt(req: Request): string | null {
  return req.headers.get('x-edge-proxy');
}

function issuePath(path: PropertyKey[]): string {
  return path.reduce<string>((out, part) => (typeof part === 'number' ? `${out}[${part}]` : `${out}.${String(part)}`), '$');
}

const GITHUB_WEBHOOK_BODY_LIMIT = 1024 * 1024;

async function readBodyBounded(req: Request, limit: number): Promise<string | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export type ServerDeps = {
  store: BusStore;
  replayStore: ReplayStore;
  githubWebhookSecret?: Uint8Array;
  /** In-process dispatcher wake — fired after every successful append. */
  onAppend: () => void;
  build: BuildInfo;
  machine: string;
  clock?: Clock;
};

export function buildRoutes(deps: ServerDeps): Route[] {
  const now: Clock = deps.clock ?? (() => new Date().toISOString());
  const routes: Route[] = [
    // ── /ctl/* — daemon ops ─────────────────────────────────────────────────
    {
      method: 'GET',
      match: exact('/ctl/health'),
      label: 'GET /ctl/health',
      handler: async () => {
        try {
          const [events, subscriptions] = await Promise.all([deps.store.count(), deps.store.lag()]);
          const body: BusHealth = {
            ok: true,
            service: 'busd',
            schema_version: BUS_SCHEMA_VERSION,
            version: deps.build.version,
            git_sha: deps.build.git_sha,
            bun: deps.build.bun,
            machine: deps.machine,
            events,
            subscriptions,
          };
          return json(body);
        } catch {
          // Honest-only health: a dead store is a dead bus, never a cached "ok".
          return json({ ok: false, service: 'busd', error: 'store_unreachable' }, 503);
        }
      },
    },
    {
      method: 'POST',
      match: exact('/ctl/reconcile'),
      label: 'POST /ctl/reconcile',
      handler: async () => {
        deps.onAppend();
        return json({ ok: true, reconciliation: 'requested' }, 202);
      },
    },
    {
      method: 'POST',
      match: exact('/ingress/github'),
      label: 'POST /ingress/github',
      handler: async (req) => {
        if (!deps.githubWebhookSecret) {
          return json({ ok: false, error: 'github_webhook_unconfigured' }, 503);
        }
        const deliveryId = req.headers.get('x-github-delivery');
        const githubEvent = req.headers.get('x-github-event');
        const signature = req.headers.get('x-hub-signature-256');
        if (!deliveryId || !githubEvent || !signature) {
          return json({ ok: false, error: 'missing_github_webhook_identity' }, 400);
        }
        const raw = await readBodyBounded(req, GITHUB_WEBHOOK_BODY_LIMIT);
        if (raw === null) return json({ ok: false, error: 'github_webhook_too_large' }, 413);
        if (!await verifyGithubSignature(deps.githubWebhookSecret, raw, signature)) {
          return json({ ok: false, error: 'invalid_github_signature' }, 401);
        }
        const eventType = GITHUB_EVENTS[githubEvent as GithubWebhookEvent];
        if (!eventType) return json({ ok: false, error: 'unsupported_github_event' }, 422);
        let document: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          document = parsed as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: 'invalid_github_payload' }, 422);
        }
        const requestHash = await sha256(`${githubEvent}\n${canonicalJson(document)}`);
        try {
          const result = await deps.replayStore.admit({
            replay_id: deliveryId,
            request_hash: requestHash,
            event: {
              replay_id: deliveryId,
              event_id: deliveryId,
              event_type: eventType,
              schema_version: 1,
              source: 'github',
              provenance: {
                machine: deps.machine,
                ingress: 'github_webhook',
                delivery_id: deliveryId,
                github_event: githubEvent,
              },
              causation_event_id: null,
              occurred_at: now(),
              payload: parseGithubNormalizedPayload(
                githubEvent as GithubWebhookEvent,
                normalizeGithubPayload(githubEvent, document),
              ),
            },
          });
          if (result.created) deps.onAppend();
          return json({
            ok: true,
            created: result.created,
            replay_id: result.event.replay_id,
            event_id: result.event.event_id,
          }, result.created ? 202 : 200);
        } catch (error) {
          if (error instanceof IdempotencyConflict) {
            return json({ ok: false, error: 'github_delivery_conflict' }, 409);
          }
          if (error instanceof Error && error.name === 'ZodError') {
            return json({ ok: false, error: 'invalid_github_delivery_identity' }, 422);
          }
          throw error;
        }
      },
    },
    {
      method: 'GET',
      match: exact('/v1/events'),
      label: 'GET /v1/events',
      handler: async (req) => {
        const url = new URL(req.url);
        const after = url.searchParams.get('after');
        const source = url.searchParams.get('source');
        const eventTypePrefix = url.searchParams.get('event_type_prefix');
        const rawLimit = url.searchParams.get('limit') ?? '200';
        if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500 ||
            (eventTypePrefix !== null &&
              !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.?$/.test(eventTypePrefix))) {
          return json({ ok: false, error: 'invalid_event_query' }, 422);
        }
        try {
          return json(await deps.replayStore.events({
            after,
            source,
            eventTypePrefix,
            limit: Number(rawLimit),
          }));
        } catch (error) {
          if (error instanceof InvalidEventCursor) {
            return json({ ok: false, error: 'invalid_event_cursor' }, 422);
          }
          throw error;
        }
      },
    },
    {
      method: 'GET',
      match: exact('/v1/replays'),
      label: 'GET /v1/replays',
      handler: async (req) => {
        const url = new URL(req.url);
        const source = url.searchParams.get('source');
        if (!source || url.searchParams.get('unfinished') !== 'true') {
          return json({ ok: false, error: 'invalid_replay_query' }, 422);
        }
        return json({ replays: await deps.replayStore.unfinished(source) });
      },
    },
    {
      method: 'POST',
      match: exact('/v1/replays/admit'),
      label: 'POST /v1/replays/admit',
      handler: async (req) => {
        const parsed = ReplayAdmissionSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          return json({ ok: false, error: 'invalid_replay_admission', field: issuePath(parsed.error.issues[0]?.path ?? []) }, 422);
        }
        try {
          const result = await deps.replayStore.admit(parsed.data);
          if (result.created) deps.onAppend();
          return json({ ok: true, ...result }, result.created ? 201 : 200);
        } catch (error) {
          if (error instanceof IdempotencyConflict) {
            return json({ ok: false, error: 'idempotency_conflict' }, 409);
          }
          throw error;
        }
      },
    },
    {
      method: 'GET',
      match: (pathname) => {
        const match = /^\/v1\/replays\/([^/]+)$/.exec(pathname);
        return match ? { replay_id: decodeURIComponent(match[1]!) } : null;
      },
      label: 'GET /v1/replays/:replay_id',
      handler: async (_req, params) => {
        const projection = await deps.replayStore.projection(params.replay_id!);
        return projection ? json(projection) : json({ ok: false, error: 'unknown_replay' }, 404);
      },
    },
    {
      method: 'POST',
      match: (pathname) => {
        const match = /^\/v1\/replays\/([^/]+)\/events$/.exec(pathname);
        return match ? { replay_id: decodeURIComponent(match[1]!) } : null;
      },
      label: 'POST /v1/replays/:replay_id/events',
      handler: async (req, params) => {
        const parsed = ReplayAppendSchema.safeParse(await readJson(req));
        if (!parsed.success || parsed.data.event.replay_id !== params.replay_id) {
          return json({ ok: false, error: 'invalid_replay_event' }, 422);
        }
        try {
          const result = await deps.replayStore.append(parsed.data.event);
          if (result.created) deps.onAppend();
          return json({ ok: true, ...result }, result.created ? 201 : 200);
        } catch (error) {
          if (error instanceof UnknownReplay) return json({ ok: false, error: 'unknown_replay' }, 404);
          if (error instanceof EventIdentityConflict) return json({ ok: false, error: 'event_identity_conflict' }, 409);
          throw error;
        }
      },
    },
    // ── /ingress/events — the generic publish door ──────────────────────────
    {
      method: 'POST',
      match: exact('/ingress/events'),
      label: 'POST /ingress/events',
      handler: async (req) => {
        const parsed = BusPublishRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) {
          return json({ ok: false, error: 'invalid_publish_request', field: issuePath(parsed.error.issues[0]?.path ?? []) }, 422);
        }
        if (parsed.data.schema_version !== BUS_SCHEMA_VERSION) {
          return json({ ok: false, error: 'schema_version_mismatch', expected: BUS_SCHEMA_VERSION }, 422);
        }
        const record = await deps.store.append({
          event_type: parsed.data.event_type,
          source: parsed.data.source,
          payload: parsed.data.payload,
          provenance: { ingress: 'events', transport_receipt: receipt(req), machine: deps.machine },
          occurred_at: parsed.data.occurred_at,
        });
        deps.onAppend();
        return json({ ok: true, seq: record.seq, event_type: record.event_type });
      },
    },
  ];

  // ── /ingress/hooks/* — the hook shim: every pinned vendor hook type is
  // consumed and journaled as `hook.<type>`. Generated from the contracts
  // enumeration so a vendor re-pin propagates by construction. No 410 tail.
  for (const hook of HOOK_TYPES) {
    routes.push({
      method: 'POST',
      match: exact(`/ingress/hooks/${hook}`),
      label: `POST /ingress/hooks/${hook}`,
      handler: async (req) => {
        const body = await readJson(req);
        if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
          return json({ ok: false, error: 'invalid_hook_payload', hook_type: hook }, 422);
        }
        const payload = body as Record<string, unknown>;
        // Attribution from the converged adapter contract's inert `harness`
        // marker; its absence is data, never a refusal (hooks are untrusted).
        const source = typeof payload.harness === 'string' && payload.harness ? payload.harness : 'unknown';
        const record = await deps.store.append({
          event_type: `hook.${hook}`,
          source,
          payload,
          provenance: { ingress: 'hooks', transport_receipt: receipt(req), machine: deps.machine },
          occurred_at: now(),
        });
        deps.onAppend();
        return json({ ok: true, seq: record.seq, event_type: record.event_type });
      },
    });
  }

  return routes;
}

const GITHUB_EVENTS: Record<string, string> = {
  pull_request: 'github.pull_request',
  pull_request_review: 'github.pull_request_review',
  pull_request_review_comment: 'github.pull_request_review_comment',
  issue_comment: 'github.issue_comment',
  check_suite: 'github.check_suite',
  check_run: 'github.check_run',
  status: 'github.commit_status',
  push: 'github.push',
  create: 'github.branch_created',
  delete: 'github.branch_deleted',
};

async function verifyGithubSignature(secret: Uint8Array, body: string, signature: string): Promise<boolean> {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(secret).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    Buffer.from(signature.slice('sha256='.length), 'hex'),
    new TextEncoder().encode(body),
  );
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(digest).toString('hex');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number | null {
  return Number.isInteger(value) ? value as number : null;
}

function normalizeGithubPayload(event: string, document: Record<string, unknown>): Record<string, unknown> {
  const repository = record(document.repository);
  const sender = record(document.sender);
  const pull = record(document.pull_request);
  const head = record(pull.head);
  const base = record(pull.base);
  const review = record(document.review);
  const checkSuite = record(document.check_suite);
  const checkRun = record(document.check_run);
  const issue = record(document.issue);
  const comment = record(document.comment);
  const app = record(event === 'check_run' ? checkRun.app : checkSuite.app);
  const normalized: Record<string, unknown> = {
    action: text(document.action),
    repository: text(repository.full_name),
    repository_id: integer(repository.id),
    sender: text(sender.login),
  };
  if (event.startsWith('pull_request')) {
    normalized.pull_request = integer(document.number) ?? integer(pull.number) ?? integer(issue.number);
    normalized.head_sha = text(head.sha) ?? text(review.commit_id);
    normalized.head_ref = text(head.ref);
    normalized.base_sha = text(base.sha);
    normalized.base_ref = text(base.ref);
    if (event === 'pull_request') {
      normalized.merged = pull.merged === true;
      normalized.merge_sha = text(pull.merge_commit_sha);
    }
  }
  if (event === 'issue_comment') {
    normalized.pull_request =
      Object.keys(record(issue.pull_request)).length > 0
        ? integer(issue.number) ?? integer(document.number)
        : null;
    normalized.head_sha = null;
    normalized.sha_binding = 'requires_pr_snapshot';
  }
  if (event === 'pull_request_review') {
    normalized.review_id = integer(review.id);
    normalized.review_state = text(review.state);
    normalized.review_commit_sha = text(review.commit_id);
  }
  if (event === 'pull_request_review_comment' || event === 'issue_comment') {
    normalized.comment_id = integer(comment.id);
    normalized.comment_author = text(record(comment.user).login);
  }
  if (event === 'pull_request_review_comment') {
    normalized.comment_commit_sha = text(comment.commit_id);
  }
  if (event === 'check_suite') {
    normalized.producer_app_id = integer(app.id);
    normalized.producer_app_slug = text(app.slug);
    normalized.head_sha = text(checkSuite.head_sha);
    normalized.status = text(checkSuite.status);
    normalized.conclusion = text(checkSuite.conclusion);
    normalized.check_suite_id = integer(checkSuite.id);
  }
  if (event === 'check_run') {
    normalized.producer_app_id = integer(app.id);
    normalized.producer_app_slug = text(app.slug);
    normalized.head_sha = text(checkRun.head_sha) ?? text(record(checkRun.check_suite).head_sha);
    normalized.check_name = text(checkRun.name);
    normalized.status = text(checkRun.status);
    normalized.conclusion = text(checkRun.conclusion);
    normalized.check_run_id = integer(checkRun.id);
  }
  if (event === 'status') {
    normalized.head_sha = text(document.sha);
    normalized.check_name = text(document.context);
    normalized.status = text(document.state);
    normalized.producer_login = text(record(document.creator).login);
  }
  if (event === 'push') {
    normalized.before_sha = text(document.before);
    normalized.head_sha = text(document.after);
    normalized.ref = text(document.ref);
  }
  if (event === 'create' || event === 'delete') {
    normalized.ref = text(document.ref);
    normalized.ref_type = text(document.ref_type);
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function makeServer(opts: ServerDeps & { bind: string; port: number }): ReturnType<typeof Bun.serve> {
  const routes = buildRoutes(opts);
  return Bun.serve({
    hostname: opts.bind,
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const params = route.match(url.pathname);
        if (!params) continue;
        try {
          return await route.handler(req, params);
        } catch {
          // DB down lands here: 5xx, no fallback, no queueing outside the DB.
          console.error(JSON.stringify({
            level: 'error',
            event: 'handler_error',
            route: route.label,
            error_code: 'internal_error',
          }));
          return json({ ok: false, error: 'internal_error' }, 500);
        }
      }
      return json({ ok: false, error: 'not_found', method: req.method, path: url.pathname }, 404);
    },
  });
}
