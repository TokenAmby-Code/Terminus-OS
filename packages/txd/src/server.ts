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
//   /ingress/tmux     managed tmux lifecycle witness events; txd resolves the
//                     page against its declaration and reconstructs if damaged.
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
  MAX_CLIPBOARD_BYTES,
  SCHEMA_VERSION,
  BusDeliverySchema,
  CloseRequestSchema,
  ClipboardPullRequestSchema,
  ClipboardPushRequestSchema,
  ClipboardSelectionRequestSchema,
  CommHookSchema,
  CommRequestSchema,
  CommWaitRequestSchema,
  DispatchRequestedSchema,
  EstateRotateRequestSchema,
  LaunchRequestSchema,
  ModeTransitionRequestSchema,
  PhysicalDeclarationSchema,
  AgentSchema,
  RegistrationAbortedSchema,
  StopRequestSchema,
  SubscribeRequestSchema,
  TmuxLifecycleEventRequestSchema,
  WrapperStartHookSchema,
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
export const CONSUMED_BUS_EVENT_TYPES = [
  'hook.wrapper_start',
  'agent.dispatch_requested',
  'agent.physical_declared',
  'agent.registered',
  'hook.stop',
  'hook.user_prompt_submit',
] as const;

const PHYSICAL_REFUSALS = new Set([
  'physical_registration_unconfigured',
  'physical_configuration_skew',
  'physical_declaration_contradicted',
  'persona_seat_incoherent',
  'physical_declaration_conflict',
  'physical_binding_conflict',
  'tint_attestation_failed',
  'physical_binding_incomplete',
  'registered_agent_physical_conflict',
  'registered_agent_package_conflict',
  'abort_of_registered_agent',
  'abort_reap_failed',
]);

const TX_COMM_FRAME = /^\[tx comm ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) from [^\]\r\n]+\]\r?\n/;

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stopHookInput(payload: Record<string, unknown>, seq: number): unknown {
  return {
    agent_id: payload.agent_id,
    schema_version: payload.schema_version ?? SCHEMA_VERSION,
    content: stringField(payload, 'content') ?? stringField(payload, 'last_assistant_message'),
    stop_event_id: stringField(payload, 'stop_event_id') ?? `bus:${seq}`,
  };
}

function promptHookInput(payload: Record<string, unknown>): unknown {
  const prompt = stringField(payload, 'prompt');
  return {
    agent_id: payload.agent_id,
    schema_version: payload.schema_version ?? SCHEMA_VERSION,
    message_id: stringField(payload, 'message_id') ?? prompt?.match(TX_COMM_FRAME)?.[1],
    content: stringField(payload, 'content'),
    stop_event_id: stringField(payload, 'stop_event_id'),
  };
}

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

async function parseSensitive<T>(req: Request, schema: MutationSchema<T>, error: string): Promise<T | Response> {
  const maxBody = (MAX_CLIPBOARD_BYTES * 6) + 4096;
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBody) return json({ ok: false, error, field: '$' }, 413);
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (!reader) return json({ ok: false, error, field: '$' }, 422);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBody) {
        await reader.cancel();
        return json({ ok: false, error, field: '$' }, 413);
      }
      chunks.push(value);
    }
  } catch {
    return json({ ok: false, error, field: '$' }, 422);
  } finally {
    reader?.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return json({ ok: false, error, field: '$' }, 422); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return json({ ok: false, error, field: issuePath(parsed.error.issues[0]?.path ?? []) }, 422);
  }
  return parsed.data;
}

function clipboardFailure(error: unknown, direction: 'pull' | 'push' | 'selection'): Response {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('exceeds')) return json({ ok: false, error: 'clipboard_too_large', direction }, 422);
  if (message.includes('valid UTF-8')) return json({ ok: false, error: 'clipboard_invalid_utf8', direction }, 422);
  return json({ ok: false, error: 'clipboard_unavailable', direction }, 409);
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
      match: exact('/agents/mode'),
      label: 'POST /agents/mode',
      handler: async (req) => {
        const parsed = await parseMutation(req, ModeTransitionRequestSchema, 'invalid_mode_request');
        if (parsed instanceof Response) return parsed;
        try {
          const result = await daemon.transitionMode(parsed, receipt(req));
          return json(result, result.ok ? 200 : 409);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: 'mode_refused', detail }, 422);
        }
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
      match: exact('/ctl/clipboard/pull'),
      label: 'POST /ctl/clipboard/pull',
      handler: async (req) => {
        // Clipboard bodies are sensitive: validation reports only a field path,
        // and neither the payload nor caught error detail is serialized/logged.
        const parsed = await parseSensitive(req, ClipboardPullRequestSchema, 'invalid_clipboard_pull_request');
        if (parsed instanceof Response) return parsed;
        try {
          return json({ ok: true, target: machine, ...await daemon.clipboardPull(parsed) });
        } catch (error) {
          return clipboardFailure(error, 'pull');
        }
      },
    },
    {
      method: 'POST',
      match: exact('/ctl/clipboard/push'),
      label: 'POST /ctl/clipboard/push',
      handler: async (req) => {
        const parsed = await parseSensitive(req, ClipboardPushRequestSchema, 'invalid_clipboard_push_request');
        if (parsed instanceof Response) return parsed;
        try {
          return json({ ok: true, target: machine, ...await daemon.clipboardPush(parsed) });
        } catch (error) {
          return clipboardFailure(error, 'push');
        }
      },
    },
    {
      method: 'POST',
      match: exact('/ctl/clipboard/selection'),
      label: 'POST /ctl/clipboard/selection',
      handler: async (req) => {
        const parsed = await parseSensitive(req, ClipboardSelectionRequestSchema, 'invalid_clipboard_selection_request');
        if (parsed instanceof Response) return parsed;
        try {
          return json({ ok: true, target: machine, ...await daemon.clipboardSelection(parsed) });
        } catch (error) {
          return clipboardFailure(error, 'selection');
        }
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
    {
      method: 'POST',
      match: exact('/ingress/tmux'),
      label: 'POST /ingress/tmux',
      handler: async (req) => {
        const parsed = await parseMutation(req, TmuxLifecycleEventRequestSchema, 'invalid_tmux_lifecycle_event');
        if (parsed instanceof Response) return parsed;
        const result = await daemon.handleTmuxLifecycleEvent(parsed, receipt(req));
        return json(result, result.ok ? 200 : 409);
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
      match: exact('/agents/close'),
      label: 'POST /agents/close',
      handler: async (req) => {
        const parsed = await parseMutation(req, CloseRequestSchema, 'invalid_close_request');
        if (parsed instanceof Response) return parsed;
        const res = await daemon.close(parsed, receipt(req));
        // Any refusal (auth, no binding, mid-turn, palace seat, reap failure —
        // request-level or any single verdict) is loud: non-2xx so a caller can
        // never read a no-op or a partial bulk close as full success. The body
        // carries the per-target verdicts either way.
        return json(res, res.ok ? 200 : 409);
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
        const physicalAck = async (operation: () => Promise<void>) => {
          try {
            await operation();
            return ack(true, null);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            if (PHYSICAL_REFUSALS.has(reason)) return ack(false, reason);
            throw error;
          }
        };
        if (event.event_type === 'hook.wrapper_start') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const hook = WrapperStartHookSchema.safeParse(event.payload);
          if (!hook.success) return ack(false, 'invalid_wrapper_start_payload');
          const result = await daemon.attestWrapperStart(hook.data);
          return ack(result.attested, result.reason);
        }
        if (event.event_type === 'agent.dispatch_requested') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const requested = DispatchRequestedSchema.safeParse(event.payload);
          if (!requested.success) return ack(false, 'invalid_dispatch_request');
          if (requested.data.machine !== machine) return ack(false, 'foreign_machine');
          return physicalAck(() => daemon.dispatch(requested.data));
        }
        if (event.event_type === 'agent.physical_declared') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const declaration = PhysicalDeclarationSchema.safeParse(event.payload);
          if (!declaration.success) return ack(false, 'invalid_physical_declaration');
          return physicalAck(() => daemon.recordPhysicalDeclaration(declaration.data, busReceipt));
        }
        if (event.event_type === 'agent.registration_aborted') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const abort = RegistrationAbortedSchema.safeParse(event.payload);
          if (!abort.success) return ack(false, 'invalid_registration_abort');
          return physicalAck(() => daemon.abortRegistration(abort.data, busReceipt));
        }
        if (event.event_type === 'agent.registered') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const agent = AgentSchema.safeParse(event.payload);
          if (!agent.success) return ack(false, 'invalid_registered_agent');
          return physicalAck(() => daemon.activateRegisteredAgent(agent.data));
        }
        if (event.event_type === 'hook.stop') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const stop = StopRequestSchema.safeParse(stopHookInput(event.payload, event.seq));
          if (!stop.success) return ack(false, 'invalid_stop_payload');
          const res = await daemon.stop(stop.data, busReceipt);
          // Ghost/schema refusal records nothing (the old door's loud refusal),
          // but the DELIVERY is acked — a ghost must not wedge the lane.
          if ('refused' in res) return ack(false, res.reason);
          if (stop.data.content !== undefined) {
            await daemon.commStop(stop.data.agent_id, stop.data.content, stop.data.stop_event_id ?? null, busReceipt);
          }
          return ack(true, null, { receipt: res });
        }
        if (event.event_type === 'hook.user_prompt_submit') {
          if (findTmuxIdDeep(event.payload)) return ack(false, 'tmux_id_refused');
          const hook = CommHookSchema.safeParse(promptHookInput(event.payload));
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
        const body: EstateReadResponse = {
          schema_version: SCHEMA_VERSION,
          rows: await daemon.estateRows(),
          tints: await daemon.tintReadiness(),
        };
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
