// HTTP surface — the RATIFIED planes ([[txd-extraction-spec]] §6). Routes are
// grouped by caller/trust plane:
//
//   /ctl/*            daemon ops (health, reconcile)
//   /ingress/hooks/*  the cross-service hook invariant: an endpoint for EVERY
//                     vendor hook type; txd consumes `stop`, everything else
//                     quick-returns 410 Gone (side-effect-free by construction).
//                     The per-box proxy broadcasts every hook to all consumers
//                     and ignores 410s — the invariant makes that safe.
//   /agents/*         the deliberate-action plane: every route directly under
//                     /agents/ is a deliberate action, one-for-one.
//   /tmux/read/*      txd's ONLY public read surface: estate observation views
//                     (seats, panes, occupancy including who is bound). Anything
//                     under read/ is side-effect-free by construction.
//
// "entities" is DEAD as public API vocabulary; per-entity event-history serving
// is REMOVED (agent biography is not txd's job — the internal event stream stays
// private replay/reconcile truth). Behavior under each route is unchanged from
// the ruled daemon spec ([[k12-daemon-spec]] §7).
//
// The route table stays exported data so committed route tests can assert the
// surface (collection-before-parameterized was the historic lesson; the ratified
// surface is exact-match only, and the tests pin that no legacy route survives).
//
// Ingress is via localhost edge_proxy ONLY (day-one purity), under the `/txd`
// proxy prefix. The daemon still binds loopback and treats the `x-edge-proxy`
// header as the transport receipt woven into event provenance.

import {
  CloseRequestSchema,
  HOOK_TYPES,
  LaunchRequestSchema,
  SendRequestSchema,
  StopRequestSchema,
  SubscribeRequestSchema,
  type EstateReadResponse,
  type HookNotConsumed,
  type HookType,
} from '@terminus-os/contracts';
import type { Daemon } from './core.ts';
import { assertNoTmuxId } from './ids.ts';

export type BuildInfo = { version: string; git_sha: string; bun: string };

export type Route = {
  method: string;
  /** Exact match, or a matcher returning captured params (null = no match). */
  match: (pathname: string) => Record<string, string> | null;
  label: string;
  handler: (req: Request, params: Record<string, string>) => Promise<Response>;
};

// The one hook type txd consumes: the stop-hook door. Every other pinned vendor
// hook type gets a 410 quick-return endpoint below.
export const CONSUMED_HOOK_TYPES: readonly HookType[] = ['stop'];

function json(body: unknown, status = 200): Response {
  // Canonical-id membrane enforcement: nothing crosses upward carrying a raw
  // tmux id. A breach fails loud rather than leaking.
  assertNoTmuxId(body, 'http_response');
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

// Ordered route table — the ordering is data so committed route tests can
// assert it. The consumed hook door is registered before the 410 tail.
export function buildRoutes(daemon: Daemon, build: BuildInfo, machine: string): Route[] {
  const routes: Route[] = [
    // ── /ctl/* — daemon ops ─────────────────────────────────────────────────
    {
      method: 'GET',
      match: exact('/ctl/health'),
      label: 'GET /ctl/health',
      handler: async () => {
        const h = await daemon.health(machine, build);
        return json(h, h.ok ? 200 : 503);
      },
    },
    {
      method: 'POST',
      match: exact('/ctl/reconcile'),
      label: 'POST /ctl/reconcile',
      handler: async (req) => {
        const res = await daemon.reconcile(receipt(req));
        // Bring-up mode: p0 contradiction ⇒ fail loud with a non-2xx.
        return json(res, res.p0 ? 409 : 200);
      },
    },
    // ── /agents/* — the deliberate-action plane ─────────────────────────────
    {
      method: 'POST',
      match: exact('/agents/launch'),
      label: 'POST /agents/launch',
      handler: async (req) => {
        const parsed = LaunchRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json({ ok: false, error: 'invalid_launch_request', detail: parsed.error.issues }, 422);
        const res = await daemon.launch(parsed.data, receipt(req));
        return json(res, res.handover ? 200 : 409);
      },
    },
    {
      method: 'POST',
      match: exact('/agents/send'),
      label: 'POST /agents/send',
      handler: async (req) => {
        const parsed = SendRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json({ ok: false, error: 'invalid_send_request', detail: parsed.error.issues }, 422);
        const res = await daemon.send(parsed.data, receipt(req));
        // Admission refusal fails loud (not admitted); gated/delivered are 200.
        if ('refused' in res) return json(res, 422);
        return json(res, 200);
      },
    },
    {
      method: 'POST',
      match: exact('/agents/close'),
      label: 'POST /agents/close',
      handler: async (req) => {
        const parsed = CloseRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json({ ok: false, error: 'invalid_close_request', detail: parsed.error.issues }, 422);
        const res = await daemon.close(parsed.data, receipt(req));
        // A refused/failed close (no binding, reap failed, schema mismatch) is loud:
        // non-2xx so a caller can never read a no-op as success.
        return json(res, res.closed ? 200 : 409);
      },
    },
    {
      method: 'POST',
      match: exact('/agents/subscribe'),
      label: 'POST /agents/subscribe',
      handler: async (req) => {
        const parsed = SubscribeRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json({ ok: false, error: 'invalid_subscribe_request', detail: parsed.error.issues }, 422);
        const res = await daemon.subscribe(parsed.data, receipt(req));
        // A refused subscribe (not bound / schema mismatch) is loud: non-2xx.
        return json(res, res.subscribed ? 200 : 409);
      },
    },
    // ── /ingress/hooks/* — the hook door + the 410 invariant tail ───────────
    {
      method: 'POST',
      match: exact('/ingress/hooks/stop'),
      label: 'POST /ingress/hooks/stop',
      handler: async (req) => {
        const parsed = StopRequestSchema.safeParse(await readJson(req));
        if (!parsed.success) return json({ ok: false, error: 'invalid_stop_request', detail: parsed.error.issues }, 422);
        const res = await daemon.stop(parsed.data, receipt(req));
        // Ghost/schema refusal fails loud (nothing recorded); recorded/deduped are 200.
        if ('refused' in res) return json(res, 422);
        return json(res, 200);
      },
    },
    // ── /tmux/read/* — the only public read surface ─────────────────────────
    {
      method: 'GET',
      match: exact('/tmux/read/estate'),
      label: 'GET /tmux/read/estate',
      handler: async () => {
        const body: EstateReadResponse = { schema_version: 1, rows: await daemon.estateRows() };
        return json(body);
      },
    },
  ];

  // Every pinned vendor hook type txd does NOT consume quick-returns 410 Gone.
  // Generated from the contracts enumeration so a vendor re-pin propagates by
  // construction — no hand-maintained tail to drift.
  for (const hook of HOOK_TYPES) {
    if (CONSUMED_HOOK_TYPES.includes(hook)) continue;
    routes.push({
      method: 'POST',
      match: exact(`/ingress/hooks/${hook}`),
      label: `POST /ingress/hooks/${hook}`,
      handler: async () => {
        const body: HookNotConsumed = { ok: false, error: 'hook_not_consumed', hook_type: hook };
        return json(body, 410);
      },
    });
  }

  return routes;
}

export function makeServer(opts: { bind: string; port: number; daemon: Daemon; build: BuildInfo; machine: string }): ReturnType<typeof Bun.serve> {
  const routes = buildRoutes(opts.daemon, opts.build, opts.machine);
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
        } catch (err) {
          console.error(JSON.stringify({ level: 'error', event: 'handler_error', route: route.label, error: String(err) }));
          // Generic body: the full error stays in the server log only. Serializing
          // String(err) could echo a raw %id back through the membrane (assertNoTmuxId).
          return json({ ok: false, error: 'internal_error' }, 500);
        }
      }
      return json({ ok: false, error: 'not_found', method: req.method, path: url.pathname }, 404);
    },
  });
}
