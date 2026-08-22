// Behavioral-pin lane: a journal consumer reads the producer-owned frontier;
// it locks only its own cursor row and never requires UPDATE on journal.head.
import { expect, test } from 'bun:test';
import type { SQL } from 'bun';
import { PostgresJournalConsumerStore, type JournalLane } from '../src/journal/durable-consumer.ts';

test('journal lane initialization reads the external head without a row lock', async () => {
  const queries: string[] = [];
  const transaction = {
    unsafe: async (query: string) => {
      queries.push(query);
      if (query.includes('journal.head')) return [{ committed_seq: 7 }];
      if (query.startsWith('INSERT')) return [];
      return [{ cursor_seq: 7, predicate_hash: 'pin', seed_kind: 'now', seed_seq: 7 }];
    },
  };
  const sql = {
    begin: async <T>(run: (tx: typeof transaction) => Promise<T>) => run(transaction),
  } as unknown as SQL;
  const lane: JournalLane = {
    name: 'pin', predicate: { exact: ['agent.registered'] }, predicateHash: 'pin',
    seed: { kind: 'now' }, batchSize: 1, decode: (event) => event, handle: async () => {},
  };

  await new PostgresJournalConsumerStore(sql, 'txd').initializeLane(lane);

  expect(queries.find((query) => query.includes('journal.head'))).toBe(
    'SELECT committed_seq FROM journal.head WHERE singleton',
  );
  expect(queries.find((query) => query.includes('journal_cursors WHERE lane'))).toContain('FOR UPDATE');
});
