import { expect, test } from 'bun:test';
import { EventLogCompactionRequestSchema, SCHEMA_VERSION } from '@terminus-os/contracts';

test('adversarial: the removed NAS-specific archive attestation stays dead', () => {
  expect(EventLogCompactionRequestSchema.safeParse({
    schema_version: SCHEMA_VERSION,
    source_agent_id: 'operator-agent',
    reset_journal_head: 8722,
    archive_attestation: `nas-restore:sha256:${'a'.repeat(64)}`,
  }).success).toBe(false);
});
