import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

test('adversarial: removed identity namespaces stay absent from runtime and documentation', () => {
  const result = Bun.spawnSync([
    'git',
    'grep',
    '-n',
    '-I',
    '-i',
    '-E',
    'TX_INSTANCE_ID|FLEET_INSTANCE_ID|instance_id|wrapper_id|source_instance|subscriber_instance|target_instance|STATIC_PERSONAS|static[_ -]persona|static[_ -]handshake|static[_ -]launch',
    '--',
    'packages',
    'README.md',
    ':(exclude)packages/**/test/**',
    ':(exclude)packages/**/migrations/**',
  ], { cwd: root });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe('');
});
