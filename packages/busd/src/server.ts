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
  ReplayIdSchema,
  ReplayAdmissionSchema,
  ReplayAppendSchema,
  type BusHealth,
} from '@terminus-os/contracts';
import type { BusStore, Clock } from './store.ts';
import {
  EventIdentityConflict,
  IdempotencyConflict,
  InvalidEventCursor,
  InvalidReplayCursor,
  TerminalStreamViolation,
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

export type ServerDeps = {
  store: BusStore;
  replayStore: ReplayStore;
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
        const after = url.searchParams.get('after');
        const rawLimit = url.searchParams.get('limit') ?? '200';
        if (!source || url.searchParams.get('unfinished') !== 'true'
            || !/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 500
            || (after !== null && !ReplayIdSchema.safeParse(after).success)) {
          return json({ ok: false, error: 'invalid_replay_query' }, 422);
        }
        try {
          return json(await deps.replayStore.unfinished({
            source,
            after,
            limit: Number(rawLimit),
          }));
        } catch (error) {
          if (error instanceof InvalidReplayCursor) {
            return json({ ok: false, error: 'invalid_replay_cursor' }, 422);
          }
          throw error;
        }
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
          if (error instanceof EventIdentityConflict) {
            return json({ ok: false, error: 'event_identity_conflict' }, 409);
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
          if (error instanceof TerminalStreamViolation) {
            return json({ ok: false, error: 'terminal_stream_append' }, 409);
          }
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
        } catch (error) {
          // DB down lands here: 5xx, no fallback, no queueing outside the DB.
          console.error(JSON.stringify({
            level: 'error',
            event: 'handler_error',
            route: route.label,
            error_code: 'internal_error',
            error_class: error instanceof Error ? error.name : 'NonError',
          }));
          return json({ ok: false, error: 'internal_error' }, 500);
        }
      }
      return json({ ok: false, error: 'not_found', method: req.method, path: url.pathname }, 404);
    },
  });
}
