// HTTP surface — the RATIFIED planes ([[txd-extraction-spec]] §6). Routes are
// grouped by caller/trust plane:
//
//   /ctl/*            daemon ops (health, reconcile)
//   /ingress/bus      the central-bus delivery door (central-bus ruling,
//                     supersedes the direct /ingress/hooks/* surface — REMOVED,
//                     no crumbs). Hook fan-in terminates at busd; txd consumes
//                     `hook.stop` / `hook.user_prompt_submit` as a normal bus
//                     subscriber and MUST 2xx-ack every other delivered event
//                     (ack ≠ consume) — bus delivery is head-of-line per
//                     subscription, so a non-2xx would wedge txd's own lane.
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
  BUS_SCHEMA_VERSION,
  BusDeliverySchema,
  CloseRequestSchema,
  CommHookSchema,
  CommRequestSchema,
  CommWaitRequestSchema,
  EstateRotateRequestSchema,
  LaunchRequestSchema,
  SendRequestSchema,
  StopRequestSchema,
  SubscribeRequestSchema,
  type EstateReadResponse,
} from '@terminus-os/contracts';
import type { Daemon } from './core.ts';
import { assertNoTmuxId, findTmuxIdDeep, sanitizeTmuxIds } from './ids.ts';

export type BuildInfo = { version: string; git_sha: string; bun: string };

export type Route = {
  method: string;
  /** Exact match, or a matcher returning captured params (null = no match). */
  match: (pathname: string) => Record<string, string> | null;
  label: string;
  handler: (req: Request, params: Record<string, string>) => Promise<Response>;
};

// The bus event types txd consumes off its `hook.%` subscription. Everything
// else delivered on the lane is acked untouched (ack ≠ consume).
export const CONSUMED_BUS_EVENT_TYPES = ['hook.stop', 'hook.user_prompt_submit'] as const;

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

function issuePath(path: PropertyKey[]): string {
  return path.reduce<string>((out, part) => typeof part === 'number' ? `${out}[${part}]` : `${out}.${String(part)}`, '$');
}

type MutationSchema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } };
};

async function parseMutation<T>(req: Request, schema: MutationSchema<T>, error: string): Promise<T | Response> {
  const body = await readJson(req);
  const rawIdPath = findTmuxIdDeep(body);
  if (rawIdPath) return json({ ok: false, error, field: rawIdPath }, 422);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return json({ ok: false, error, field: issuePath(parsed.error.issues[0]?.path ?? []) }, 422);
  }
  return parsed.data;
}

async function rejectRawMutation(req: Request, error: string): Promise<Response | null> {
  const body = await readJson(req);
  const rawIdPath = findTmuxIdDeep(body);
  return rawIdPath ? json({ ok: false, error, field: rawIdPath }, 422) : null;
}

// Ordered route table — the ordering is data so committed route tests can
// assert it.
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
      match: exact('/agents/comm'),
      label: 'POST /agents/comm',
      handler: async (req) => {
        const parsed = await parseMutation(req, CommRequestSchema, 'invalid_comm_request');
        if (parsed instanceof Response) return parsed;
        try {
          return json(await daemon.comm(parsed, receipt(req)));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: 'comm_refused', detail }, 422);
        }
      },
    },
    {
      method: 'POST',
      match: exact('/agents/comm/wait'),
      label: 'POST /agents/comm/wait',
      handler: async (req) => {
        const parsed = await parseMutation(req, CommWaitRequestSchema, 'invalid_comm_wait_request');
        if (parsed instanceof Response) return parsed;
        return json(await daemon.waitComm(parsed));
      },
    },
    {
      method: 'POST',
      match: exact('/ctl/reconcile'),
      label: 'POST /ctl/reconcile',
      handler: async (req) => {
        const rejected = await rejectRawMutation(req, 'invalid_reconcile_request');
        if (rejected) return rejected;
        const res = await daemon.reconcile(receipt(req));
        // Bring-up mode: p0 contradiction ⇒ fail loud with a non-2xx.
        return json(res, res.p0 ? 409 : 200);
      },
    },
    {
      method: 'POST',
      match: exact('/ctl/estate/rotate'),
      label: 'POST /ctl/estate/rotate',
      handler: async (req) => {
        const parsed = await parseMutation(req, EstateRotateRequestSchema, 'invalid_estate_rotate_request');
        if (parsed instanceof Response) return parsed;
        if (parsed.scope !== 'estate') {
          const result = await daemon.resetEstateScope(parsed, receipt(req));
          return json(result, result.accepted ? 200 : 409);
        }
        const result = await daemon.requestEstateRotation(parsed, receipt(req));
        if (!result.accepted) return json(result, 409);
        const encoded = new TextEncoder().encode(JSON.stringify(result));
        let sent = false;
        return new Response(new ReadableStream({
          pull(controller) {
            if (sent) return;
            sent = true;
            controller.enqueue(encoded);
            controller.close();
            queueMicrotask(() => void daemon.executeEstateRotation());
          },
        }), { status: 202, headers: { 'content-type': 'application/json' } });
      },
    },
    // ── /agents/* — the deliberate-action plane ─────────────────────────────
    {
      method: 'POST',
      match: exact('/agents/launch'),
      label: 'POST /agents/launch',
      handler: async (req) => {
        const parsed = await parseMutation(req, LaunchRequestSchema, 'invalid_launch_request');
        if (parsed instanceof Response) return parsed;
        const res = await daemon.launch(parsed, receipt(req));
        return json(res, res.handover ? 200 : 409);
      },
    },
    {
      method: 'POST',
      match: exact('/agents/send'),
      label: 'POST /agents/send',
      handler: async (req) => {
        const parsed = await parseMutation(req, SendRequestSchema, 'invalid_send_request');
        if (parsed instanceof Response) return parsed;
        const res = await daemon.send(parsed, receipt(req));
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
        const parsed = await parseMutation(req, CloseRequestSchema, 'invalid_close_request');
        if (parsed instanceof Response) return parsed;
        const res = await daemon.close(parsed, receipt(req));
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
        const parsed = await parseMutation(req, SubscribeRequestSchema, 'invalid_subscribe_request');
        if (parsed instanceof Response) return parsed;
        const res = await daemon.subscribe(parsed, receipt(req));
        // A refused subscribe (not bound / schema mismatch) is loud: non-2xx.
        return json(res, res.subscribed ? 200 : 409);
      },
    },
    // ── /ingress/bus — the central-bus delivery door ────────────────────────
    // busd POSTs one full journal row per delivery (BusDeliverySchema) and
    // retries the SAME event until 2xx — head-of-line, never a skip. So the
    // honest outcomes here are: 422 ONLY for envelope/contract skew (which
    // SHOULD block loudly), and 2xx for everything else — with `consumed`
    // reporting whether txd actually ingested the event. A refused stop
    // (ghost) or malformed hook payload is acked-not-consumed: exactly the
    // no-footprint outcome of the old direct door, without wedging the lane.
    //
    // NOTE: no whole-body raw-tmux-id pre-scan (unlike parseMutation): the
    // lane carries all hook.% payloads, and unconsumed ones may legitimately
    // contain %N-shaped text (tool output). The membrane applies to what txd
    // actually ingests — the unwrapped consumed payloads — below.
    {
      method: 'POST',
      match: exact('/ingress/bus'),
      label: 'POST /ingress/bus',
      handler: async (req) => {
        const parsed = BusDeliverySchema.safeParse(await readJson(req));
        if (!parsed.success) {
          return json({ ok: false, error: 'invalid_bus_delivery', field: issuePath(parsed.error.issues[0]?.path ?? []) }, 422);
        }
        if (parsed.data.schema_version !== BUS_SCHEMA_VERSION) {
          return json({ ok: false, error: 'invalid_bus_delivery', field: '$.schema_version' }, 422);
        }
        const { event } = parsed.data;
        // The transport receipt now points into the bus journal row that
        // delivered this event — attributable straight back to bus.events.seq.
        const busReceipt = `bus:${event.seq}`;
        const ack = (consumed: boolean, reason: string | null, extra: Record<string, unknown> = {}) =>
          json({ ok: true, seq: event.seq, consumed, reason, ...extra });
        if (event.event_type === 'hook.stop') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const stop = StopRequestSchema.safeParse(event.payload);
          if (!stop.success) return ack(false, 'invalid_stop_payload');
          const res = await daemon.stop(stop.data, busReceipt);
          // Ghost/schema refusal records nothing (the old door's loud refusal),
          // but the DELIVERY is acked — a ghost must not wedge the lane.
          if ('refused' in res) return ack(false, res.reason);
          if (stop.data.content !== undefined) {
            await daemon.commStop(stop.data.instance_id, stop.data.content, stop.data.stop_event_id ?? null, busReceipt);
          }
          return ack(true, null, { receipt: res });
        }
        if (event.event_type === 'hook.user_prompt_submit') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const hook = CommHookSchema.safeParse(event.payload);
          if (!hook.success) return ack(false, 'invalid_user_prompt_submit_payload');
          try {
            return ack(true, null, { receipt: await daemon.promptSubmitted(hook.data, busReceipt) });
          } catch (error) {
            // Deterministic domain refusal — a natural prompt-submit with no
            // comm-message context — must not wedge the lane. Anything else
            // (infra failure) propagates to 500 so busd retries it.
            if (error instanceof Error && error.message === 'message_target_mismatch') {
              return ack(false, 'message_target_mismatch');
            }
            throw error;
          }
        }
        return ack(false, 'not_consumed');
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
          console.error(JSON.stringify({ level: 'error', event: 'handler_error', route: route.label, error: sanitizeTmuxIds(String(err)) }));
          // Generic body: the full error stays in the server log only. Serializing
          // String(err) could echo a raw %id back through the membrane (assertNoTmuxId).
          return json({ ok: false, error: 'internal_error' }, 500);
        }
      }
      return json({ ok: false, error: 'not_found', method: req.method, path: url.pathname }, 404);
    },
  });
}
