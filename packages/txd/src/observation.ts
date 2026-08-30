import type { SQL } from 'bun';
import {
  PROBE_RUNGS,
  assertProbeSet,
  makeObservationHandler,
  type Deadline,
  type Holding,
  type HoldingSource,
  type Observation,
  type ObservationHandler,
  type ObservationStore,
  type Probe,
} from '@tokenamby-code/stc-contract/observation';
import { runningRuntimeMarker } from '@tokenamby-code/stc-contract/version';
import type { Daemon } from './core.ts';
import type { EventStore } from './store.ts';
import type { TmuxControlPlane } from './tmux.ts';
import type { DurableJournalConsumer } from './journal/durable-consumer.ts';
import type { PgNotificationListener } from './journal/pg-listener.ts';
import { SERVICE_IDENTITY } from './identity.ts';

const FIVE_MINUTE_OBSERVATION_CEILING = {
  ms: 300_000,
  derivedFrom: 'fleet-wide 5-minute unit stop floor (Emperor ruling 2026-08-13)',
} satisfies Deadline;

export type TxdObservationSource = {
  postgres(signal: AbortSignal): Promise<Observation>;
  tmuxSocket(signal: AbortSignal): Promise<Observation>;
  journalConsumer(signal: AbortSignal): Promise<Observation>;
  lifecycleHooks(signal: AbortSignal): Promise<Observation>;
  commTransport(signal: AbortSignal): Promise<Observation>;
  contradictions(signal: AbortSignal): Promise<Observation>;
  estate(signal: AbortSignal): Promise<Observation>;
  events(signal: AbortSignal): Promise<Holding>;
  contradictionsHeld(signal: AbortSignal): Promise<Holding>;
  bindings(signal: AbortSignal): Promise<Holding>;
  freelist(signal: AbortSignal): Promise<Holding>;
  zombies(signal: AbortSignal): Promise<Holding>;
  divergence(signal: AbortSignal): Promise<Holding>;
};

type Cancellable<T> = PromiseLike<T> & { cancel(): unknown };

async function cancellable<T>(query: Cancellable<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    query.cancel();
    throw signal.reason ?? new Error('observation_aborted');
  }
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {
      try { query.cancel(); } finally { reject(signal.reason ?? new Error('observation_aborted')); }
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve(query), aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('observation_aborted');
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('observation_aborted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener('abort', abort); }
}

type JournalRows = {
  cursor: number | bigint | string;
  frontier: number | bigint | string;
  open_poison: number | bigint | string;
  poison_codes: string[] | null;
};

export function createTxdObservationSource(options: {
  store: EventStore;
  tmux: TmuxControlPlane;
  daemon: Daemon;
  journalSql: SQL;
  journalConsumer: DurableJournalConsumer;
  journalListener: PgNotificationListener;
}): TxdObservationSource {
  const projection = (signal: AbortSignal) => abortable(options.daemon.observationProjection(), signal);
  const divergences = (signal: AbortSignal) => abortable(options.tmux.estateDivergences(), signal);

  async function journal(signal: AbortSignal): Promise<JournalRows> {
    const rows = await cancellable(options.journalSql`
      SELECT cursor.cursor_seq AS cursor,
             head.committed_seq AS frontier,
             count(poison.event_seq)::int AS open_poison,
             coalesce(array_agg(poison.error_code ORDER BY poison.event_seq)
               FILTER (WHERE poison.event_seq IS NOT NULL), ARRAY[]::text[]) AS poison_codes
      FROM txd.journal_cursors cursor
      CROSS JOIN journal.head head
      LEFT JOIN txd.journal_poison poison
        ON poison.lane = cursor.lane AND poison.disposition IS NULL
      WHERE cursor.lane = 'txd-events' AND head.singleton
      GROUP BY cursor.cursor_seq, head.committed_seq
    ` as Cancellable<JournalRows[]>, signal);
    if (!rows[0]) throw new Error('txd journal projection absent');
    return rows[0];
  }

  return {
    async postgres(signal) {
      const evidence = await options.store.observePostgres(signal);
      return { state: 'ready', evidence };
    },
    async tmuxSocket(signal) {
      const reachable = await abortable(options.tmux.reachable(), signal);
      return reachable
        ? { state: 'ready', evidence: { reachable } }
        : { state: 'failed', detail: 'tmux socket is unreachable', evidence: { reachable } };
    },
    async journalConsumer(signal) {
      const row = await journal(signal);
      const listener = options.journalListener.health();
      const consumer = options.journalConsumer.inspect();
      const cursor = Number(row.cursor);
      const frontier = Number(row.frontier);
      const poisonCodes = row.poison_codes ?? [];
      const evidence = {
        cursor,
        frontier,
        lag: frontier - cursor,
        open_poison: Number(row.open_poison),
        poison_codes: poisonCodes,
        listener_state: listener.state,
        drain_running: consumer.drainRunning,
      };
      if (Number(row.open_poison) > 0) {
        return { state: 'failed', detail: `undisposed journal poison: ${poisonCodes.join(', ')}`, evidence };
      }
      if (listener.state !== 'listening') {
        return { state: 'failed', detail: `journal listener is ${listener.state}`, evidence };
      }
      if (cursor !== frontier) return { state: 'blocked', detail: 'journal consumer has unapplied events', evidence };
      return { state: 'ready', evidence };
    },
    async lifecycleHooks(signal) {
      const hooks = await abortable(options.tmux.lifecycleHookReadiness(), signal);
      const evidence = { state: hooks.state, pane_died: hooks.pane_died, pane_exited: hooks.pane_exited };
      return hooks.state === 'ready'
        ? { state: 'ready', evidence }
        : { state: 'failed', detail: 'tmux lifecycle hooks are incomplete', evidence };
    },
    async commTransport(signal) {
      const targets = await options.store.unresolvedCommTransportTargets(signal);
      const evidence = { unresolved_target_agent_ids: targets };
      return targets.length === 0
        ? { state: 'ready', evidence }
        : { state: 'failed', detail: 'zero-byte transport refusal remains unresolved', evidence };
    },
    async contradictions(signal) {
      const open = (await projection(signal)).openContradictions;
      const evidence = {
        count: open.length,
        kinds: open.map((row) => row.kind).sort(),
        records: open.map((row) => ({ entity_type: row.entity_type, entity_id: row.entity_id, kind: row.kind })),
      };
      return open.length === 0
        ? { state: 'ready', evidence }
        : { state: 'failed', detail: 'named contradictions remain open', evidence };
    },
    async estate(signal) {
      const rows = await divergences(signal);
      const evidence = { divergences: rows.length, records: rows };
      return rows.length === 0
        ? { state: 'ready', evidence }
        : { state: 'blocked', detail: 'foreign, pending, or divergent estate', evidence };
    },
    async events(signal) {
      return { count: await options.store.count(signal), breakdown: {} };
    },
    async contradictionsHeld(signal) {
      const rows = (await projection(signal)).openContradictions;
      return {
        count: rows.length,
        breakdown: Object.fromEntries([...new Set(rows.map((row) => row.kind))].sort().map((kind) => [kind, rows.filter((row) => row.kind === kind).length])),
        records: rows.map((row) => ({ kind: row.kind, entity_id: row.entity_id, first_seen_at: row.occurred_at })),
      };
    },
    async bindings(signal) {
      const rows = (await projection(signal)).currentBindings;
      return {
        count: rows.length,
        breakdown: { registered: rows.filter((row) => row.registered).length, pending: rows.filter((row) => !row.registered).length },
        evidence: { debt: 'agent-semantic surface is reported here and is not part of observation identity' },
        records: rows.map((row) => ({
          seat_id: row.seat_id,
          agent_id: row.agent_id,
          registered: row.registered,
          ticket_id: row.ticket_id,
        })),
      };
    },
    async freelist(signal) {
      const rows = (await projection(signal)).freelist;
      return {
        count: rows.length,
        breakdown: { live: rows.filter((row) => row.pane_state === 'live').length, empty: rows.filter((row) => row.pane_state === 'empty').length },
        records: rows,
      };
    },
    async zombies(signal) {
      const rows = await abortable(options.daemon.zombieEnvelopes(), signal);
      return { count: rows.length, breakdown: {}, records: rows };
    },
    async divergence(signal) {
      const rows = await divergences(signal);
      return {
        count: rows.length,
        breakdown: Object.fromEntries([...new Set(rows.map((row) => row.clause))].sort().map((clause) => [clause, rows.filter((row) => row.clause === clause).length])),
        records: rows,
      };
    },
  };
}

export function makeTxdObservationHandler(options: {
  source: TxdObservationSource;
  observationStore: ObservationStore;
  machine: string;
  version: string;
}): ObservationHandler {
  const deadline = () => ({ ...FIVE_MINUTE_OBSERVATION_CEILING });
  const probes: Probe[] = [
    { name: 'postgres', rung: PROBE_RUNGS[0], deadline: deadline(), caveats: ['read-only SELECT'], observe: options.source.postgres },
    { name: 'tmux-socket', rung: PROBE_RUNGS[0], deadline: deadline(), caveats: ['read-only socket query'], observe: options.source.tmuxSocket },
    { name: 'journal-consumer', rung: PROBE_RUNGS[1], deadline: deadline(), caveats: ['every undisposed poison is non-green'], observe: options.source.journalConsumer },
    { name: 'estate', rung: PROBE_RUNGS[1], deadline: deadline(), caveats: ['estateDivergences is the only estate read; never actuates'], observe: options.source.estate },
    { name: 'lifecycle-hooks', rung: PROBE_RUNGS[2], deadline: deadline(), caveats: ['read-back of installed witnesses'], observe: options.source.lifecycleHooks },
    { name: 'comm-transport', rung: PROBE_RUNGS[2], deadline: deadline(), caveats: ['bounded current-binding projection query'], observe: options.source.commTransport },
    { name: 'contradictions', rung: PROBE_RUNGS[2], deadline: deadline(), caveats: ['every named contradiction remains visible'], observe: options.source.contradictions },
  ];
  assertProbeSet(probes);
  const holdings: HoldingSource[] = [
    ['events', options.source.events],
    ['contradictions', options.source.contradictionsHeld],
    ['bindings', options.source.bindings],
    ['freelist', options.source.freelist],
    ['zombies', options.source.zombies],
    ['divergence', options.source.divergence],
  ].map(([name, read]) => ({ name: name as string, deadline: deadline(), read: read as HoldingSource['read'] }));
  return makeObservationHandler({
    identity: SERVICE_IDENTITY,
    version: options.version,
    stcVersion: runningRuntimeMarker().version,
    machine: options.machine,
    probes,
    holdings,
    observationStore: options.observationStore,
  });
}
