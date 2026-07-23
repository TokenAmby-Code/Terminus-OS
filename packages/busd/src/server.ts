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
  type BusHealth,
} from '@terminus-os/contracts';
import type { BusStore, Clock } from './store.ts';

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
        } catch (err) {
          // Honest-only health: a dead store is a dead bus, never a cached "ok".
          return json({ ok: false, service: 'busd', error: 'store_unreachable', detail: String(err) }, 503);
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
        } catch (err) {
          // DB down lands here: 5xx, no fallback, no queueing outside the DB.
          console.error(JSON.stringify({ level: 'error', event: 'handler_error', route: route.label, error: String(err) }));
          return json({ ok: false, error: 'internal_error' }, 500);
        }
      }
      return json({ ok: false, error: 'not_found', method: req.method, path: url.pathname }, 404);
    },
  });
}
