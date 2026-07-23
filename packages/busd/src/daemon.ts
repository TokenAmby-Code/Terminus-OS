// Entrypoint. Wires config → bus store (migrations at boot, fail loud) →
// dispatcher → server. Source-run under Bun, no build step. systemd user unit
// owns the process. If Postgres is down, connect() throws and the unit
// restarts on-failure — the ruled no-fallback posture.

import { describeEndpoint } from '@terminus-os/db';
import { loadConfig } from './config.ts';
import { PostgresBusStore } from './store.ts';
import { Dispatcher } from './dispatcher.ts';
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
const dispatcher = new Dispatcher(store, {
  repairIntervalMs: cfg.repairIntervalMs,
  deliveryTimeoutMs: cfg.deliveryTimeoutMs,
  batchSize: cfg.batchSize,
  backoffBaseMs: cfg.backoffBaseMs,
  backoffCapMs: cfg.backoffCapMs,
});
const server = makeServer({
  bind: cfg.bind,
  port: cfg.port,
  store,
  onAppend: () => dispatcher.wake(),
  build,
  machine: cfg.machine,
});
dispatcher.start();

console.log(
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
  // Graceful, but bounded: stop scheduling deliveries, let in-flight requests
  // finish, never let a stuck request block termination. The delivery cursor
  // is durable — an interrupted retry simply re-runs after restart.
  dispatcher.stop();
  await Promise.race([server.stop(), Bun.sleep(5_000)]);
  await store.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
