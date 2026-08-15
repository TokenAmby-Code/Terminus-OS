import { SQL } from 'bun';
import { userInfo } from 'node:os';
import {
  AgentSchema,
  DispatchRequestedSchema,
  PhysicalDeclarationSchema,
  RegistrationAbortedSchema,
} from '@terminus-os/contracts';
import type { DbEndpointT } from '@terminus-os/db';
import type { Daemon } from './core.ts';
import { makeJournalReceipt } from './journal-receipt.ts';
import {
  DurableJournalConsumer,
  PoisonEventError,
  PostgresJournalConsumerStore,
  type JournalEvent,
  type JournalLane,
} from './journal/durable-consumer.ts';
import { PgNotificationListener } from './journal/pg-listener.ts';

export type TxdJournalEvent = JournalEvent & { seq: number };

export type TxdEventJournal = {
  sql: SQL;
  lane: JournalLane<TxdJournalEvent>;
  consumer: DurableJournalConsumer;
  listener: PgNotificationListener;
};

const PHYSICAL_REFUSALS = new Set([
  'physical_registration_unconfigured',
  'physical_configuration_skew',
  'physical_declaration_contradicted',
  'persona_seat_incoherent',
  'physical_declaration_conflict',
  'physical_binding_conflict',
  'tint_attestation_failed',
  'physical_binding_incomplete',
  'registered_agent_physical_conflict',
  'registered_agent_package_conflict',
  'abort_of_registered_agent',
  'abort_reap_failed',
]);

function poison(code: string, event: TxdJournalEvent, detail: Record<string, unknown> = {}): never {
  throw new PoisonEventError(code, { event_type: event.event_type, ...detail });
}

export function createTxdEventLane(options: {
  machine: string;
  daemon: Daemon;
}): JournalLane<TxdJournalEvent> {
  return {
    name: 'txd-events',
    predicate: {
      exact: [
        'agent.dispatch_requested',
        'agent.physical_declared',
        'agent.registration_aborted',
        'agent.registered',
      ],
    },
    predicateHash: 'sha256:txd-events:journal-v2',
    seed: { kind: 'now' },
    batchSize: 32,
    decode(event) {
      const seq = Number(event.seq);
      if (event.schema_version !== 1
        || event.estate !== options.machine
        || event.placement !== options.machine
        || !Number.isSafeInteger(seq)
        || seq < 1
        || event.payload === null
        || typeof event.payload !== 'object'
        || Array.isArray(event.payload)) {
        throw new PoisonEventError('invalid_txd_event', { field: 'envelope' });
      }
      return { ...event, seq };
    },
    async handle(_transaction, event) {
      const receipt = makeJournalReceipt(event.seq);
      try {
        if (event.event_type === 'agent.dispatch_requested') {
          const parsed = DispatchRequestedSchema.safeParse(event.payload);
          if (!parsed.success) poison('invalid_dispatch_request', event);
          if (parsed.data.machine !== options.machine) poison('foreign_dispatch_machine', event);
          await options.daemon.dispatch(parsed.data, receipt);
          return;
        }
        if (event.event_type === 'agent.physical_declared') {
          const parsed = PhysicalDeclarationSchema.safeParse(event.payload);
          if (!parsed.success) poison('invalid_physical_declaration', event);
          await options.daemon.recordPhysicalDeclaration(parsed.data, receipt);
          return;
        }
        if (event.event_type === 'agent.registration_aborted') {
          const parsed = RegistrationAbortedSchema.safeParse(event.payload);
          if (!parsed.success) poison('invalid_registration_abort', event);
          await options.daemon.abortRegistration(parsed.data, receipt);
          return;
        }
        if (event.event_type === 'agent.registered') {
          const parsed = AgentSchema.safeParse(event.payload);
          if (!parsed.success) poison('invalid_registered_agent', event);
          await options.daemon.activateRegisteredAgent(parsed.data);
          return;
        }
        poison('unhandled_txd_event', event);
      } catch (error) {
        if (error instanceof PoisonEventError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (PHYSICAL_REFUSALS.has(reason)) {
          poison(reason, event);
        }
        throw error;
      }
    },
  };
}

export function createTxdJournalConnection(endpoint: DbEndpointT): { sql: SQL; account: string } {
  if (endpoint.kind !== 'socket') {
    throw new Error('txd journal requires the peer-authenticated PostgreSQL socket');
  }
  const account = userInfo().username;
  const sql = new SQL({
    adapter: 'postgres',
    path: endpoint.socket_dir,
    port: endpoint.port,
    database: endpoint.database,
    username: account,
    max: 2,
    connection: { application_name: 'txd-journal' },
  });
  return { sql, account };
}

export function createTxdEventJournal(options: {
  machine: string;
  endpoint: Extract<DbEndpointT, { kind: 'socket' }>;
  daemon: Daemon;
  sql: SQL;
  account: string;
}): TxdEventJournal {
  const lane = createTxdEventLane({ machine: options.machine, daemon: options.daemon });
  const consumer = new DurableJournalConsumer({
    lanes: [lane],
    store: new PostgresJournalConsumerStore(options.sql, 'txd'),
  });
  const listener = new PgNotificationListener({
    endpoint: { kind: 'unix', path: `${options.endpoint.socket_dir}/.s.PGSQL.${options.endpoint.port}` },
    user: options.account,
    database: options.endpoint.database,
    applicationName: 'txd-journal-listener',
    maxFrameBytes: 1_048_576,
    reconnectDelayMs: ({ attempt }) => Math.min(30_000, 250 * (2 ** Math.min(attempt, 7))),
    onDrainRequested: () => consumer.requestDrain(),
  });
  return { sql: options.sql, lane, consumer, listener };
}
