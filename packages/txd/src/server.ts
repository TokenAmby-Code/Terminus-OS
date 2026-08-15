// HTTP surface — the RATIFIED planes ([[txd-extraction-spec]] §6). Routes are
// grouped by caller/trust plane:
//
//   /ctl/*            daemon ops (health, reconcile)
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
  MAX_CLIPBOARD_BYTES,
  SCHEMA_VERSION,
  CloseRequestSchema,
  ClipboardPullRequestSchema,
  ClipboardPushRequestSchema,
  ClipboardSelectionRequestSchema,
  CommRequestSchema,
  CommHookSchema,
  CommReceiptWaitRequestSchema,
  AgentInjectRequestSchema,
  CommRedriveRequestSchema,
  CommWaitRequestSchema,
  EstateRotateRequestSchema,
  LaunchRequestSchema,
  ModeTransitionRequestSchema,
  RunRequestSchema,
  StopRequestSchema,
  TmuxLifecycleEventRequestSchema,
  WrapperStartHookSchema,
  LcdServiceDeliverySchema,
  type EstateReadResponse,
} from '@terminus-os/contracts';
import type { Daemon } from './core.ts';
import { EnvelopeInventoryError } from './envelopes.ts';
import { assertNoTmuxIdInIdentifiers, sanitizeTmuxIds } from './ids.ts';

export type BuildInfo = { version: string; git_sha: string; bun: string };

export type Route = {
  method: string;
  /** Exact match, or a matcher returning captured params (null = no match). */
  match: (pathname: string) => Record<string, string> | null;
  label: string;
  handler: (req: Request, params: Record<string, string>) => Promise<Response>;
};

// Every comm frame the flush carried, not just the one that happened to land
// first. A frame always begins its own line, so the line anchor still refuses
// an id quoted mid-sentence; `m` lets it find the second and third frame of a
// coalesced submission instead of stopping at character zero.
//
// Matching only the first frame cost real deliveries: on 2026-08-03, fourteen
// comms across eight stamped workers arrived in a coalesced flush, were read by
// their target, and were recorded by txd as never delivered.
const TX_COMM_FRAME = /^\[tx comm ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) from [^\]\r\n]+\]\r?$/gm;

export function commFrameMessageIds(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(TX_COMM_FRAME)) seen.add(match[1]!);
  return [...seen];
}

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function promptHookInput(payload: Record<string, unknown>): unknown {
  const prompt = stringField(payload, 'prompt');
  return {
    agent_id: payload.agent_id,
    schema_version: payload.schema_version ?? SCHEMA_VERSION,
    message_ids: commFrameMessageIds(prompt),
    content: prompt,
    stop_event_id: stringField(payload, 'stop_event_id'),
    session_id: stringField(payload, 'session_id'),
  };
}

function stopHookInput(payload: Record<string, unknown>): unknown {
  return {
    agent_id: payload.agent_id,
    schema_version: payload.schema_version ?? SCHEMA_VERSION,
    content: stringField(payload, 'content') ?? stringField(payload, 'last_assistant_message'),
    stop_event_id: stringField(payload, 'stop_event_id'),
  };
}

function json(body: unknown, status = 200): Response {
  // Canonical-id membrane enforcement: no IDENTIFIER crosses upward carrying a
  // raw tmux id. A breach fails loud rather than leaking. Response CONTENT —
  // an agent's reply, a stop hook's last message — is data and is not judged.
  assertNoTmuxIdInIdentifiers(body, 'http_response');
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type KeepaliveScheduler = (emit: () => void, intervalMs: number) => () => void;

const scheduleKeepalive: KeepaliveScheduler = (emit, intervalMs) => {
  const timer = setInterval(emit, intervalMs);
  return () => clearInterval(timer);
};

export function deferredJson(
  body: Promise<unknown>,
  keepaliveMs = 30_000,
  schedule: KeepaliveScheduler = scheduleKeepalive,
): Response {
  const encoder = new TextEncoder();
  let stopKeepalive: (() => void) | undefined;
  let open = true;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // A single legal JSON whitespace byte commits the response headers. The
      // stream then sleeps entirely on the callback event; there is no poll or
      // heartbeat loop.
      controller.enqueue(encoder.encode(' '));
      // Bun's fetch client independently abandons a response body after about
      // one minute without bytes. Whitespace is legal before a JSON value, so
      // keep the transport active while callback completion remains entirely
      // event-driven. This interval observes no state and performs no poll.
      stopKeepalive = schedule(() => {
        if (open) controller.enqueue(encoder.encode(' '));
      }, keepaliveMs);
      void body.then((value) => {
        if (!open) return;
        assertNoTmuxIdInIdentifiers(value, 'http_response');
        controller.enqueue(encoder.encode(JSON.stringify(value)));
        controller.close();
      }).catch((error) => {
        if (open) controller.error(error);
      }).finally(() => {
        open = false;
        stopKeepalive?.();
      });
    },
    cancel() {
      open = false;
      stopKeepalive?.();
    },
  }), { headers: { 'content-type': 'application/json' } });
}

function exact(path: string) {
  return (pathname: string) => (pathname === path ? {} : null);
}

// One trailing path segment, captured as `message_id`. A comm id is a uuid, so
// a segment carrying a slash is not one and does not match.
function prefix(base: string) {
  return (pathname: string) => {
    if (!pathname.startsWith(base)) return null;
    const message_id = pathname.slice(base.length);
    return message_id.length > 0 && !message_id.includes('/') ? { message_id } : null;
  };
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

// The inbound membrane is the SCHEMA: every field that declares itself an
// identifier is a CanonicalIdSchema and refuses a raw tmux id on its own path.
// Request content is never scanned — a body is the caller's prose, and no
// predicate over prose can know what the caller meant by an id.
async function parseMutation<T>(req: Request, schema: MutationSchema<T>, error: string): Promise<T | Response> {
  const body = await readJson(req);
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
      match: exact('/agents/inject'),
      label: 'POST /agents/inject',
      handler: async (req) => {
        const parsed = await parseMutation(req, AgentInjectRequestSchema, 'invalid_agent_inject_request');
        if (parsed instanceof Response) return parsed;
        try { return json(await daemon.inject(parsed, receipt(req))); }
        catch (error) { return json({ ok: false, error: 'agent_inject_refused', detail: String(error) }, 422); }
      },
    },
    {
      method: 'POST',
      match: exact('/agents/run'),
      label: 'POST /agents/run',
      handler: async (req) => {
        const parsed = await parseMutation(req, RunRequestSchema, 'invalid_run_request');
        if (parsed instanceof Response) return parsed;
        let result: Awaited<ReturnType<Daemon['run']>>;
        try {
          result = await daemon.run(parsed, receipt(req));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: 'run_refused', detail }, 409);
        }
        if (result.mode === 'agent') return json(result.response);
        // The command runs exactly as long as it runs: the headers commit now
        // and the body completes from the pane's wait-for signal (same
        // transport contract as /agents/comm/wait — no deadline over the
        // wait). A late failure still lands as a typed refusal body.
        return deferredJson(result.pending.catch((error) => ({
          ok: false,
          error: 'run_refused',
          detail: error instanceof Error ? error.message : String(error),
        })));
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
      match: exact('/agents/comm/receipt'),
      label: 'POST /agents/comm/receipt',
      handler: async (req) => {
        const parsed = await parseMutation(req, CommReceiptWaitRequestSchema, 'invalid_comm_receipt_request');
        if (parsed instanceof Response) return parsed;
        return deferredJson(daemon.waitCommReceipt(parsed));
      },
    },
    {
      method: 'POST',
      match: exact('/agents/comm/redrive'),
      label: 'POST /agents/comm/redrive',
      handler: async (req) => {
        const parsed = await parseMutation(req, CommRedriveRequestSchema, 'invalid_comm_redrive_request');
        if (parsed instanceof Response) return parsed;
        try {
          return json(await daemon.commRedrive(parsed, receipt(req)));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: 'comm_redrive_refused', detail }, 422);
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
        // Return the response head immediately, then complete the body from the
        // callback event. Bun's client has a shorter wait-for-headers ceiling
        // than the ruled seven-minute ask window; awaiting here made that
        // transport ceiling silently defeat the domain contract.
        return deferredJson(daemon.waitComm(parsed));
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
      match: exact('/ingress/hooks/user_prompt_submit'),
      label: 'POST /ingress/hooks/user_prompt_submit',
      handler: async (req) => {
        const raw = await readJson(req);
        const parsed = CommHookSchema.safeParse(raw && typeof raw === 'object' && !Array.isArray(raw)
          ? promptHookInput(raw as Record<string, unknown>) : raw);
        if (!parsed.success) return json({ ok: false, error: 'invalid_user_prompt_submit_payload' }, 422);
        try { return json(await daemon.promptSubmitted(parsed.data, receipt(req))); }
        catch (error) {
          if (error instanceof Error && error.message === 'message_target_mismatch') {
            return json({ ok: true, asserted: [], dead_lettered: [], consumed: false });
          }
          throw error;
        }
      },
    },
    {
      method: 'POST',
      match: exact('/ingress/hooks/stop'),
      label: 'POST /ingress/hooks/stop',
      handler: async (req) => {
        const raw = await readJson(req);
        const parsed = StopRequestSchema.safeParse(raw && typeof raw === 'object' && !Array.isArray(raw)
          ? stopHookInput(raw as Record<string, unknown>) : raw);
        if (!parsed.success) return json({ ok: false, error: 'invalid_stop_payload' }, 422);
        const stopped = await daemon.stop(parsed.data, receipt(req));
        if ('refused' in stopped) return json({ ok: true, consumed: false, reason: stopped.reason });
        if (parsed.data.content !== undefined) {
          await daemon.commStop(parsed.data.agent_id, parsed.data.content, parsed.data.stop_event_id ?? null, receipt(req));
        }
        return json({ ok: true, consumed: true, receipt: stopped });
      },
    },
    {
      method: 'POST',
      match: prefix('/ingress/hooks/'),
      label: 'POST /ingress/hooks/:type',
      handler: async () => new Response(null, { status: 410 }),
    },
    {
      method: 'POST',
      match: exact('/ctl/reconcile'),
      label: 'POST /ctl/reconcile',
      handler: async (req) => {
        // Reconcile takes no caller-supplied identifier; its body is unused.
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
        // Any refusal (auth, no binding, mid-turn, reap failure —
        // request-level or any single verdict) is loud: non-2xx so a caller can
        // never read a no-op or a partial bulk close as full success. The body
        // carries the per-target verdicts either way.
        return json(res, res.ok ? 200 : 409);
      },
    },
    // The lcd typed lifecycle-fact door — txd as a service subscriber of
    // lifecycled's typed subscription plane. lcd retries a non-2xx delivery
    // under its lane backoff and never skips a fact, so the honest outcomes
    // 422 only for envelope skew, 2xx for everything else with `consumed`
    // reporting whether txd ingested the fact.
    {
      method: 'POST',
      match: exact('/ingress/lifecycle'),
      label: 'POST /ingress/lifecycle',
      handler: async (req) => {
        const parsed = LcdServiceDeliverySchema.safeParse(await readJson(req));
        if (!parsed.success) {
          return json({ ok: false, error: 'invalid_lcd_delivery', field: issuePath(parsed.error.issues[0]?.path ?? []) }, 422);
        }
        const { fact } = parsed.data;
        const ack = (consumed: boolean, reason: string | null) =>
          json({ ok: true, seq: fact.seq, consumed, reason });
        if (fact.fact_type === 'wrapper_started') {
          const hook = WrapperStartHookSchema.safeParse(fact.payload);
          if (!hook.success) return ack(false, 'invalid_wrapper_start_payload');
          const result = await daemon.attestWrapperStart(hook.data);
          return ack(result.attested, result.reason);
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
    {
      // Phase two, on demand. The quick release already handed the caller a
      // message_id; this is where that handle is redeemed for the delivery
      // fact, without anything blocking on an event that may be hours away.
      method: 'GET',
      match: prefix('/tmux/read/comm/'),
      label: 'GET /tmux/read/comm/:message_id',
      handler: async (_req, params) => {
        try {
          return json(await daemon.commDelivery(params.message_id!));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return json({ ok: false, error: 'comm_delivery_unreadable', detail }, 404);
        }
      },
    },
    {
      method: 'GET',
      match: exact('/tmux/read/zombies'),
      label: 'GET /tmux/read/zombies',
      handler: async () => {
        // On-demand join of remote envelopes against live bindings; derived,
        // never stored. Session names carry no raw tmux %ids by construction.
        try {
          const zombies = await daemon.zombieEnvelopes();
          return json({ schema_version: SCHEMA_VERSION, zombies });
        } catch (error) {
          if (error instanceof EnvelopeInventoryError) {
            return json({ ok: false, error: 'envelope_inventory_failed' }, 502);
          }
          throw error;
        }
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
    // Comm asks deliberately wait on an event for up to seven minutes. Bun's
    // positive values top out below the Emperor-ruled 300-second sanity floor,
    // so disable the transport idle timeout instead of installing a shorter,
    // contradictory deadline.
    idleTimeout: 0,
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
          // String(err) could echo a raw %id back through the membrane.
          return json({ ok: false, error: 'internal_error' }, 500);
        }
      }
      return json({ ok: false, error: 'not_found', method: req.method, path: url.pathname }, 404);
    },
  });
}
