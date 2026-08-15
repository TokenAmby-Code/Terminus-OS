import { SQL } from 'bun';
import { userInfo } from 'node:os';
import {
  AgentSchema,
  CommHookSchema,
  DispatchRequestedSchema,
  PhysicalDeclarationSchema,
  RegistrationAbortedSchema,
  SCHEMA_VERSION,
  StopRequestSchema,
} from '@terminus-os/contracts';
import type { DbEndpointT } from '@terminus-os/db';
import type { Daemon } from './core.ts';
import { commFrameMessageIds } from './server.ts';
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

function stringField(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stopInput(payload: Record<string, unknown>, seq: number): unknown {
  return {
    agent_id: payload.agent_id,
    schema_version: payload.schema_version ?? SCHEMA_VERSION,
    content: stringField(payload, 'content') ?? stringField(payload, 'last_assistant_message'),
    stop_event_id: stringField(payload, 'stop_event_id') ?? `journal:${seq}`,
  };
}

function promptInput(payload: Record<string, unknown>): unknown {
  const prompt = stringField(payload, 'prompt');
  return {
    agent_id: payload.agent_id,
    schema_version: payload.schema_version ?? SCHEMA_VERSION,
    message_ids: commFrameMessageIds(prompt),
    content: prompt,
    stop_event_id: stringField(payload, 'stop_event_id'),
    session_id: stringField(payload, 'session_id'),
  };
}

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
        'agent.stop',
        'agent.prompt_submitted',
      ],
    },
    predicateHash: 'sha256:txd-events:journal-v1',
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
        if (event.event_type === 'agent.stop') {
          const parsed = StopRequestSchema.safeParse(stopInput(event.payload, event.seq));
          if (!parsed.success) poison('invalid_stop_payload', event);
          const stopped = await options.daemon.stop(parsed.data, receipt);
          if ('refused' in stopped) poison(stopped.reason, event);
          if (parsed.data.content !== undefined) {
            await options.daemon.commStop(parsed.data.agent_id, parsed.data.content, parsed.data.stop_event_id ?? null, receipt);
          }
          return;
        }
        if (event.event_type === 'agent.prompt_submitted') {
          const parsed = CommHookSchema.safeParse(promptInput(event.payload));
          if (!parsed.success) poison('invalid_prompt_submitted_payload', event);
          await options.daemon.promptSubmitted(parsed.data, receipt);
          return;
        }
        poison('unhandled_txd_event', event);
      } catch (error) {
        if (error instanceof PoisonEventError) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (PHYSICAL_REFUSALS.has(reason) || reason === 'message_target_mismatch') {
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
}) {
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
