// Entrypoint. Wires config → event store → tmux control plane → core → server.
// Source-run under Bun, no build step. systemd user unit owns the process.

import { describeEndpoint } from '@terminus-os/db';
import { notifySystemd } from '@tokenamby-code/stc-contract/systemd-notify';
import { PostgresObservationStore } from '@tokenamby-code/stc-contract/observation';
import { loadConfig } from './config.ts';
import { PostgresEventStore } from './store.ts';
import { RealTmux } from './tmux.ts';
import { CommGateTransportFailure, Daemon, type CommWatchArmInput } from './core.ts';
import { makeServer } from './server.ts';
import { ProcessEstateRotationBarrier } from './rotation-lock.ts';
import { makeJournalPublisher } from './events.ts';
import { createTxdEventJournal, createTxdJournalConnection } from './event-journal.ts';
import { realRemoteEnvelopeLister } from './envelopes.ts';
import { parseClipboardMachineRegistry } from './clipboard-origin.ts';
import { SERVICE_VERSION } from './identity.ts';
import { createTxdObservationSource, makeTxdObservationHandler } from './observation.ts';
import { loadFleetTimezone } from '@tokenamby-code/stc-contract/fleet-time';

await loadFleetTimezone();

const build = {
  version: SERVICE_VERSION,
  git_sha: process.env.GIT_SHA ?? 'unknown',
  bun: Bun.version,
};

const cfg = await loadConfig();
// The lifecycle gate owns its five-minute contract. Composer repaint has its
// own short event-driven verifier inside RealTmux; conflating these two waits
// let one pane monopolize txd long enough for hook delivery to time out.
const LIFECYCLED_LOCAL_RESPONSE_MARGIN_MS = 1_000;
const lifecycledFetchCeilingMs = cfg.commWatchTimeoutMs + LIFECYCLED_LOCAL_RESPONSE_MARGIN_MS;

async function postLifecycledGate(
  path: '/agents/comm/gate' | '/agents/composer/gate',
  body: Record<string, unknown>,
  refusalPrefix: 'lifecycled_comm_gate' | 'lifecycled_composer_gate',
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`http://lifecycled${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      unix: cfg.lifecycledSocket!,
      signal: AbortSignal.timeout(lifecycledFetchCeilingMs),
      body: JSON.stringify(body),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? 'transport_ceiling_exceeded'
      : 'transport_failed';
    throw new CommGateTransportFailure(`${refusalPrefix}_${reason}`);
  }
  if (response.ok) return;
  const refusal = await response.json().catch(() => null) as { error?: unknown } | null;
  const reason = typeof refusal?.error === 'string' ? refusal.error : `http_${response.status}`;
  throw new Error(`${refusalPrefix}_refused:${reason}`);
}
// Connect + migrate (forward-only, shared migrations home) — fail loud at boot.
const store = await PostgresEventStore.connect(cfg.db);
const machineRegistry = parseClipboardMachineRegistry(await Bun.file(cfg.machineRegistryPath).json());
const tmux = new RealTmux(cfg.tmuxSocket, { machine: cfg.machine, machineRegistry });
const rotationBarrier = new ProcessEstateRotationBarrier(cfg.rotationLockFile, cfg.rotationSignalFifo);
// The pre-send comm watch, armed against lifecycled's local ingress socket.
// The await is bounded outside lifecycled's own gate contract. A typed refusal
// or an early transport failure leaves an unpainted target untouched. A client
// ceiling is not an unarmed-watch fact: lifecycled already held the request for
// the complete server-owned interval, so txd attempts bytes and waits for the
// ordinary delivery effect.
const commWatchArm = cfg.lifecycledSocket
  ? async (input: CommWatchArmInput) => {
      await postLifecycledGate('/agents/comm/gate', {
          schema_version: 1,
          message_id: input.message_id,
          source_agent_id: input.source_agent_id,
          target_agent_id: input.target_agent_id,
          stream_class: 'interactive',
          composer_interactive_observed: input.composer_interactive_observed,
        }, 'lifecycled_comm_gate');
    }
  : null;
const composerGate = cfg.lifecycledSocket
  ? async (input: { correlation_id: string; target_agent_id: string }) => {
      await postLifecycledGate('/agents/composer/gate', { schema_version: 1, ...input, stream_class: 'interactive' }, 'lifecycled_composer_gate');
    }
  : null;
// The journal connection owns both txd's durable cursor and its producer.
// It is opened before physical registration is exposed so no outcome can
// accidentally fall back to a transport service.
if (cfg.db.kind !== 'socket') throw new Error('txd journal requires the production socket endpoint');
const journalConnection = createTxdJournalConnection(cfg.db);
const physicalRegistration = cfg.physicalRegistration
  ? {
      machine: cfg.machine,
      configuration: {
        generation: cfg.physicalRegistration.generation,
        digest: cfg.physicalRegistration.digest,
      },
      agentWrapper: cfg.agentWrapper,
      perpetual: cfg.physicalRegistration.perpetual,
      sshSeatTargets: cfg.sshSeatTargets,
      publish: makeJournalPublisher(journalConnection.sql, cfg.machine),
    }
  : null;
const daemon = new Daemon(store, tmux, undefined, rotationBarrier, physicalRegistration, realRemoteEnvelopeLister, commWatchArm, composerGate);
const eventJournal = createTxdEventJournal({
  machine: cfg.machine,
  endpoint: cfg.db,
  daemon,
  ...journalConnection,
});
await eventJournal.consumer.initialize();
await eventJournal.listener.start();
await eventJournal.listener.registered();
await eventJournal.consumer.requestDrain();
const observationStore = await PostgresObservationStore.connect({
  socketDir: cfg.db.socket_dir,
  port: cfg.db.port,
  database: cfg.db.database,
  schema: 'txd',
  applicationName: 'txd-observations',
  statementCeilingMs: 300_000,
  statementCeilingDerivedFrom: 'fleet-wide 5-minute unit stop floor (Emperor ruling 2026-08-13)',
});
const observation = makeTxdObservationHandler({
  source: createTxdObservationSource({
    store,
    tmux,
    daemon,
    journalSql: eventJournal.sql,
    journalConsumer: eventJournal.consumer,
    journalListener: eventJournal.listener,
  }),
  observationStore,
  machine: cfg.machine,
  version: SERVICE_VERSION,
});
const server = makeServer({
  bind: cfg.bind,
  port: cfg.port,
  daemon,
  machine: cfg.machine,
  observation,
  journalPoisonDisposer: eventJournal.poisonDisposer,
});

console.log(
  JSON.stringify({
    level: 'info',
    event: 'listening',
    url: `http://${cfg.bind}:${cfg.port}`,
    machine: cfg.machine,
    db: describeEndpoint(cfg.db),
    tmux_socket: cfg.tmuxSocket,
    build,
  }),
);

// The control plane is serving: the journal listener is registered, its drain
// is requested and the server is bound — the same edge the log above records,
// told to systemd. Under Type=notify this write is what completes the start
// job, so `systemctl restart txd.service` returns here rather than at fork.
//
// Deliberately BEFORE the estate rung below. Standing the estate reconciles
// external tmux state, and txd's own availability must never be hostage to it:
// a wedged estate has to find txd up and answering /health, which is the
// surface an operator reads to see that the estate is what is wrong. The rung
// below already treats an unresolved estate as a legitimate state rather than
// a failure.
await notifySystemd('ready');

// Stand the canonical persistent estate declaratively (rung 2). A predecessor
// topology deliberately left in place for an operator-owned rotation remains
// opaque: txd stays available, does not resolve it, and performs no mutation.
const est = await daemon.constructEstateAtBoot();
if (est === null) {
  console.error(JSON.stringify({
    level: 'info',
    event: 'estate_activation_pending',
    action: 'explicit_estate_rotation_required',
  }));
} else {
  await daemon.finalizeEstateRotation();
  // Structured logs go to stderr here as elsewhere in the daemon (core.ts).
  console.error(
    JSON.stringify({
      level: 'info',
      event: 'estate_constructed',
      created: est.created.length,
      existing: est.existing.length,
      backfilled: est.backfilled.length,
      failed: est.failed.length,
      created_seats: est.created,
      backfilled_seats: est.backfilled,
    }),
  );
}

async function shutdown() {
  await notifySystemd('stopping');
  // Graceful, but bounded: let in-flight requests finish, yet never let a stuck
  // request block termination — close the store and exit after 5s regardless.
  const failures: unknown[] = [];
  for (const cleanup of [
    () => Promise.race([server.stop(), Bun.sleep(5_000)]),
    () => eventJournal.listener.stop(),
    () => eventJournal.consumer.settle(),
    () => observationStore.close(),
    () => eventJournal.sql.close(),
    () => store.close(),
  ]) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  for (const error of failures) console.error(error);
  process.exit(failures.length === 0 ? 0 : 1);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
