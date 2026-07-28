// Entrypoint. Wires config → bus store (migrations at boot, fail loud) →
// dispatcher → server. Source-run under Bun, no build step. systemd user unit
// owns the process. If Postgres is down, connect() throws and the unit
// restarts on-failure — the ruled no-fallback posture.

import { describeEndpoint } from '@terminus-os/db';
import { loadConfig } from './config.ts';
import { PostgresBusStore } from './store.ts';
import { PostgresReplayStore } from './replay-store.ts';
import { Dispatcher, ReplayDispatcher } from './dispatcher.ts';
import { makeServer, type BuildInfo } from './server.ts';
import { resolveGitSha } from './build.ts';
import { notifyReady } from './systemd-notify.ts';

const build: BuildInfo = {
  version: '0.1.0',
  // Resolved from the checkout this file was loaded from (src/ → package dir);
  // rev-parse walks up to the repo root, so the daemon subdir is sufficient.
  git_sha: resolveGitSha(new URL('..', import.meta.url).pathname),
  bun: Bun.version,
};

const cfg = await loadConfig();
// Connect + migrate (forward-only, shared migrations home, advisory-locked
// against concurrent booters) — fail loud at boot.
const store = await PostgresBusStore.connect(cfg.db);
const replayStore = await PostgresReplayStore.connect(cfg.db);
await replayStore.reconcileSubscriptions(cfg.subscriptions);
const dispatcher = new Dispatcher(store, {
  deliveryTimeoutMs: cfg.deliveryTimeoutMs,
  batchSize: cfg.batchSize,
});
const replayDispatcher = new ReplayDispatcher(replayStore, {
  deliveryTimeoutMs: cfg.deliveryTimeoutMs,
  batchSize: cfg.batchSize,
});
let githubWebhookSecret: Uint8Array | undefined;
if (cfg.githubWebhookSecretFile) {
  const file = Bun.file(cfg.githubWebhookSecretFile);
  if (!await file.exists()) throw new Error('configured GitHub webhook credential is unavailable');
  const value = (await file.text()).trim();
  if (!value) throw new Error('configured GitHub webhook credential is empty');
  githubWebhookSecret = new TextEncoder().encode(value);
}
const server = makeServer({
  bind: cfg.bind,
  port: cfg.port,
  store,
  replayStore,
  onAppend: () => {
    dispatcher.wake();
    replayDispatcher.wake();
  },
  build,
  machine: cfg.machine,
  // Config validation guarantees the secret and the App id arrive as a pair;
  // the github door stays fail-closed unless both are present.
  ...(githubWebhookSecret && cfg.githubWebhookAppId !== null
    ? { githubWebhookSecret, githubWebhookAppId: cfg.githubWebhookAppId }
    : {}),
});
dispatcher.start();
replayDispatcher.start();

console.info(
  JSON.stringify({
    level: 'info',
    event: 'listening',
    url: `http://${cfg.bind}:${cfg.port}`,
    machine: cfg.machine,
    db: describeEndpoint(cfg.db),
    build,
  }),
);

// The bus is bound and both dispatchers are scheduling: the same edge the log
// above records, told to systemd. Under Type=notify this is what completes the
// start job, so `systemctl restart busd.service` returns here rather than at
// fork.
notifyReady();

async function shutdown() {
  // Stop scheduling and await the bounded transport requests already in flight.
  // Their timeout is the configured transport contract, not a second shutdown
  // timer. Durable delivery state reconciles any process-level interruption.
  await Promise.all([dispatcher.stop(), replayDispatcher.stop()]);
  await server.stop();
  await store.close();
  await replayStore.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
