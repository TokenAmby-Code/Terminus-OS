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
