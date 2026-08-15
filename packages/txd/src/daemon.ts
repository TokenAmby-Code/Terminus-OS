// Entrypoint. Wires config → event store → tmux control plane → core → server.
// Source-run under Bun, no build step. systemd user unit owns the process.

import { describeEndpoint } from '@terminus-os/db';
import { loadConfig } from './config.ts';
import { PostgresEventStore } from './store.ts';
import { RealTmux } from './tmux.ts';
import { Daemon, type CommWatchArmInput } from './core.ts';
import { makeServer, type BuildInfo } from './server.ts';
import { resolveGitSha } from './build.ts';
import { ProcessEstateRotationBarrier } from './rotation-lock.ts';
import { makeJournalPublisher } from './events.ts';
import { createTxdEventJournal, createTxdJournalConnection } from './event-journal.ts';
import { realRemoteEnvelopeLister } from './envelopes.ts';

const build: BuildInfo = {
  version: '0.1.0',
  // Resolved from the checkout this file was loaded from (src/ → package dir);
  // rev-parse walks up to the repo root, so the daemon subdir is sufficient.
  git_sha: resolveGitSha(new URL('..', import.meta.url).pathname),
  bun: Bun.version,
};

const cfg = await loadConfig();
// The server owns a five-minute composer wait. One second is the health
// contract for a local unix-socket round trip, so the client remains strictly
// outside the server ceiling without an unlabelled multiplier.
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
    throw new Error(`${refusalPrefix}_${reason}`);
  }
  if (response.ok) return;
  const refusal = await response.json().catch(() => null) as { error?: unknown } | null;
  const reason = typeof refusal?.error === 'string' ? refusal.error : `http_${response.status}`;
  throw new Error(`${refusalPrefix}_refused:${reason}`);
}
// Connect + migrate (forward-only, shared migrations home) — fail loud at boot.
const store = await PostgresEventStore.connect(cfg.db);
const tmux = new RealTmux(cfg.tmuxSocket, {
  machine: cfg.machine,
  composerObserveTimeoutMs: cfg.commWatchTimeoutMs,
});
const rotationBarrier = new ProcessEstateRotationBarrier(cfg.rotationLockFile, cfg.rotationSignalFifo);
// The pre-send comm watch, armed against lifecycled's local ingress socket.
// The await is bounded by the same transport contract as lifecycled's delivery
// awaits; a refusal or timeout surfaces
// as act.comm_watch_unarmed and leaves the target pane untouched.
const commWatchArm = cfg.lifecycledSocket
  ? async (input: CommWatchArmInput) => {
      await postLifecycledGate('/agents/comm/gate', {
          schema_version: 1,
          message_id: input.message_id,
          source_agent_id: input.source_agent_id,
          target_agent_id: input.target_agent_id,
          stream_class: input.stream_class,
          composer_interactive_observed: input.composer_interactive_observed,
        }, 'lifecycled_comm_gate');
    }
  : null;
const composerGate = cfg.lifecycledSocket
  ? async (input: { correlation_id: string; target_agent_id: string; stream_class: 'interactive' | 'headless' }) => {
      await postLifecycledGate('/agents/composer/gate', { schema_version: 1, ...input }, 'lifecycled_composer_gate');
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
      commStreams: cfg.physicalRegistration.commStreams ?? {},
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
const server = makeServer({ bind: cfg.bind, port: cfg.port, daemon, build, machine: cfg.machine });

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
  // Graceful, but bounded: let in-flight requests finish, yet never let a stuck
  // request block termination — close the store and exit after 5s regardless.
  const failures: unknown[] = [];
  for (const cleanup of [
    () => Promise.race([server.stop(), Bun.sleep(5_000)]),
    () => eventJournal.listener.stop(),
    () => eventJournal.consumer.settle(),
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
