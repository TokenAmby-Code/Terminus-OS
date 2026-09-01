import type { TxdRequest } from './client.ts';
import {
  CLIPBOARD_BUFFER_NAME,
  ClipboardPullResponseSchema,
  ClipboardPushResponseSchema,
  MAX_CLIPBOARD_BASE64_CHARS,
  MAX_CLIPBOARD_BYTES,
  COMM_WAIT_TIMEOUT_MS,
  HookDiagnosticsResponseSchema,
  SCHEMA_VERSION,
  type ClipboardPushResponse,
} from '@terminus-os/contracts';
import type { LocalClipboard } from './clipboard.ts';
import {
  isFailure,
  readStdinContent,
  tokenize,
  type Invocation,
} from '@tokenamby-code/stc-contract/cli';

export type CommandContext = {
  args: string[];
  request: TxdRequest;
  write: (value: unknown) => void;
  clipboard: () => LocalClipboard;
};

export type Command = {
  path: readonly string[];
  summary: string;
  run: (context: CommandContext) => Promise<number>;
};

export class CliGrammarError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CliGrammarError';
  }
}

export function parseInvocation(args: string[], allowed: readonly string[]): Invocation {
  const parsed = tokenize(args, (name) => allowed.includes(name), 'tx');
  if (isFailure(parsed)) throw new CliGrammarError(parsed.code, parsed.message);
  for (const name of Object.keys(parsed.params)) {
    if (!allowed.includes(name)) {
      throw new CliGrammarError('unknown_parameter', `unknown parameter ${name}=`);
    }
  }
  return parsed;
}

function booleanParameter(parsed: Invocation, name: string): boolean {
  const value = parsed.params[name];
  if (value === undefined) return false;
  if (value !== 'true') {
    throw new CliGrammarError('invalid_parameter', `${name}= accepts exactly true`);
  }
  return true;
}

function positionalOnly(args: string[]): string[] {
  const parsed = parseInvocation(args, []);
  if (parsed.content !== undefined) throw new CliGrammarError('unexpected_content', 'this command accepts no content');
  return parsed.args;
}

function agentSource(verb: string): string {
  const value = process.env.AGENT_ID;
  if (!value) throw new Error(`AGENT_ID is required for tx ${verb}`);
  return value;
}

async function comm({ args, request, write }: CommandContext): Promise<number> {
  const parsed = parseInvocation(args, ['ask', 'reply', 'self', 'page', 'command', 'skill']);
  const ask = booleanParameter(parsed, 'ask');
  const reply = booleanParameter(parsed, 'reply');
  const self = booleanParameter(parsed, 'self');
  const page = parsed.params.page;
  if (page === '') throw new CliGrammarError('invalid_parameter', 'page= requires a page name');
  const intentEntries = (['command', 'skill'] as const)
    .filter((kind) => parsed.params[kind] !== undefined)
    .map((kind) => [kind, parsed.params[kind]!] as const);
  let suppliedContent = parsed.content === undefined
    ? undefined
    : parsed.content.source === 'stdin'
      ? await readStdinContent()
      : parsed.content.value;
  let intent: { kind: 'command' | 'skill'; name: string; args: string[] } | undefined;
  if (intentEntries.length > 1) throw new Error('command and skill intents are mutually exclusive');
  if (intentEntries.length === 1) {
    if (page || reply || self || ask || parsed.args.length !== 1) {
      throw new Error('usage: tx comm <identity> command=<name> [-- args] | tx comm <identity> skill=<name> [-- args]');
    }
    const [kind, name] = intentEntries[0]!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)) {
      throw new Error('command and skill names never include /, $, whitespace, or an engine selector');
    }
    const intentArgs = suppliedContent === undefined ? [] : [suppliedContent];
    intent = { kind, name, args: intentArgs };
  }
  const positional = [...parsed.args];
  if (!intent && suppliedContent === undefined) suppliedContent = positional.pop();
  if (reply) {
    if (page || self || ask || positional.length !== 0 || suppliedContent === undefined) {
      throw new Error('usage: tx comm reply=true [message | content=... | -- ... | -]');
    }
  } else if (page) {
    if (self || positional.length !== 0 || suppliedContent === undefined) {
      throw new Error('usage: tx comm [ask=true] page=<page> [message | content=... | -- ... | -]');
    }
  } else if (self) {
    if (positional.length !== 0 || suppliedContent === undefined) {
      throw new Error('usage: tx comm self=true [ask=true] [message | content=... | -- ... | -]');
    }
  } else if (!intent && (positional.length !== 1 || suppliedContent === undefined)) {
    throw new Error('usage: tx comm <identity> [ask=true] [message | content=... | -- ... | -]');
  }
  const accepted = await request('POST', '/agents/comm', {
    schema_version: SCHEMA_VERSION, source_agent_id: agentSource('comm'),
    ...(intent ? { intent } : { message: suppliedContent! }), ask, reply,
    ...(page ? { page } : {}), ...(self ? { target: '--self' } : {}),
    ...(!page && !reply && !self ? { target: parsed.args[0] } : {}),
  }) as { ok?: boolean; message_id?: string; ask_id?: string | null };
  if (accepted.ok === false || !accepted.message_id) {
    write(accepted);
    return 1;
  }
  // The admission is already durable and is the sender's only recovery key.
  // Print it before the event-driven receipt join so an unbounded pane
  // transport/validation wait cannot hide a message id that txd committed.
  write(accepted);
  const receipt = await request('POST', '/agents/comm/receipt', {
    schema_version: SCHEMA_VERSION,
    message_id: accepted.message_id,
    source_agent_id: agentSource('comm'),
  }) as { ok?: boolean };
  write(receipt);
  if (receipt.ok === false) return 1;
  if (!ask) return 0;
  const result = await request('POST', '/agents/comm/wait', {
    schema_version: SCHEMA_VERSION, ask_id: accepted.ask_id, subscriber_agent_id: agentSource('comm'), timeout_ms: COMM_WAIT_TIMEOUT_MS,
  }) as { complete: boolean };
  write(result);
  return result.complete ? 0 : 3;
}

function decodedPush(response: ClipboardPushResponse): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(response.content_base64)) {
    throw new Error('txd returned invalid clipboard encoding');
  }
  const bytes = Uint8Array.from(Buffer.from(response.content_base64, 'base64'));
  if (bytes.byteLength !== response.bytes || bytes.byteLength > MAX_CLIPBOARD_BYTES) {
    throw new Error('txd returned inconsistent clipboard byte count');
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error('txd returned invalid UTF-8 clipboard content'); }
}

/** The single extension point: subcommands add one declarative entry here. */
export const COMMANDS: readonly Command[] = [
  { path: ['comm'], summary: '<identity> [ask=true] <message>; page=/reply=/self=/command=/skill= and content/stdin use the fleet grammar; caller supplies no /, $, or engine flag', run: comm },
  {
    path: ['journal', 'dispose'],
    summary: 'Dispose one txd journal poison by event sequence with a required reason',
    run: async ({ args, request, write }) => {
      const usage = 'usage: tx journal dispose event-seq=<positive bigint> reason=<reason>';
      const parsed = parseInvocation(args, ['event-seq', 'reason']);
      const rawEventSeq = parsed.params['event-seq'];
      const reason = parsed.params.reason;
      if (parsed.args.length || parsed.content !== undefined || !/^[1-9][0-9]*$/.test(rawEventSeq ?? '') || !reason?.trim()) {
        throw new Error(usage);
      }
      const eventSeq = rawEventSeq!;
      if (BigInt(eventSeq) > 9_223_372_036_854_775_807n) throw new Error(usage);
      write(await request('POST', '/ctl/journal/poison/dispose', {
        schema_version: SCHEMA_VERSION,
        source_agent_id: agentSource('journal dispose'),
        event_seq: eventSeq,
        reason,
      }));
      return 0;
    },
  },
  {
    path: ['inspect', 'hooks'],
    summary: 'Read bounded txd-owned tmux hook diagnostics from the system journal',
    run: async ({ args, request, write }) => {
      const parsed = parseInvocation(args, ['limit']);
      const rawLimit = parsed.params.limit;
      if (parsed.args.length || parsed.content !== undefined || (rawLimit !== undefined && !/^[0-9]+$/.test(rawLimit))) {
        throw new Error('usage: tx inspect hooks [limit=<1-1000>]');
      }
      const limit = rawLimit === undefined ? 100 : Number(rawLimit);
      if (limit < 1 || limit > 1000) throw new Error('usage: tx inspect hooks [limit=<1-1000>]');
      const response = HookDiagnosticsResponseSchema.safeParse(
        await request('GET', `/tmux/read/diagnostics/hooks?limit=${limit}`),
      );
      if (!response.success) throw new Error('txd returned invalid hook diagnostics');
      write(response.data);
      return 0;
    },
  },
  {
    // The second phase of a comm, asked for rather than waited on. `tx comm`
    // still quick-releases; this redeems the message_id it returned for the
    // delivery fact whenever the caller wants to know.
    path: ['comm', 'delivery'],
    summary: 'Read the delivery fact for one comm by message id',
    run: async ({ args, request, write }) => {
      const positional = positionalOnly(args);
      const messageId = positional[0];
      if (!messageId || positional.length > 1) throw new Error('usage: tx comm delivery <message-id>');
      write(await request('GET', `/tmux/read/comm/${encodeURIComponent(messageId)}`));
      return 0;
    },
  },
  {
    // One command against one pane, branching on txd's event truth: an agent
    // seat gets the engine's `!` shell escape (output lands in that agent's
    // conversation); a bare seat executes and this caller gets the captured
    // stdout/stderr and exit code back.
    path: ['run'],
    summary: '<target> <command> — agent panes get the engine !-escape; bare panes execute and return output',
    run: async ({ args, request, write }) => {
      const positional = positionalOnly(args);
      if (positional.length !== 2) throw new Error('usage: tx run <target> <command>');
      const result = await request('POST', '/agents/run', {
        schema_version: SCHEMA_VERSION,
        target: positional[0],
        command: positional[1],
      }) as { ok: boolean; detail?: string };
      // A pane run's body completes after the headers, so a late typed
      // refusal (the pane died mid-run) arrives as ok:false in a 200 body.
      if (!result.ok) throw new Error(result.detail ?? 'run_refused');
      write(result);
      return 0;
    },
  },
  {
    path: ['close'],
    summary: 'Close remote agents through the retirement chain (overseer verb)',
    run: async ({ args, request, write }) => {
      const usage = 'usage: tx close <target> [<target> ...] [force=true] | tx close page=<page> | tx close all-idle=true';
      const parsed = parseInvocation(args, ['force', 'page', 'all-idle']);
      if (parsed.content !== undefined) throw new Error(usage);
      const force = booleanParameter(parsed, 'force');
      const page = parsed.params.page;
      const allIdle = booleanParameter(parsed, 'all-idle');
      const targets = parsed.args;
      const selectors = (targets.length ? 1 : 0) + (page ? 1 : 0) + (allIdle ? 1 : 0);
      // Exactly one selector; force is explicit-targets only (filters are
      // inherently graceful) — mirrors the daemon contract, refused pre-transport.
      if (selectors !== 1 || (force && targets.length === 0)) throw new Error(usage);
      write(await request('POST', '/agents/close', {
        schema_version: SCHEMA_VERSION,
        source_agent_id: agentSource('close'),
        ...(targets.length ? { targets } : {}),
        ...(page ? { page } : {}),
        ...(allIdle ? { all_idle: true } : {}),
        ...(force ? { force: true } : {}),
      }));
      return 0;
    },
  },
  {
    path: ['mode'],
    summary: 'Enter, toggle, or approve plan mode through txd event truth',
    run: async ({ args, request, write }) => {
      const parsed = parseInvocation(args, ['target', 'trigger']);
      const action = parsed.args[0];
      const target = parsed.params.target;
      const rawTrigger = parsed.params.trigger;
      if (rawTrigger !== undefined && rawTrigger !== 'preplan' && rawTrigger !== 'context_cycle') {
        throw new Error('trigger= must be preplan or context_cycle');
      }
      const trigger: 'operator' | 'preplan' | 'context_cycle' = rawTrigger ?? 'operator';
      if ((action !== 'enter' && action !== 'toggle' && action !== 'approve') || !target) {
        throw new Error('usage: tx mode <enter | toggle | approve> target=<identity> [trigger=<preplan | context_cycle>]');
      }
      if (parsed.args.length !== 1 || parsed.content !== undefined) throw new Error('usage: tx mode <enter | toggle | approve> target=<identity> [trigger=<preplan | context_cycle>]');
      const intent = action === 'enter' ? 'enter_plan' : action === 'toggle' ? 'toggle_plan' : 'approve_plan';
      write(await request('POST', '/agents/mode', {
        schema_version: SCHEMA_VERSION,
        target,
        intent,
        trigger,
      }));
      return 0;
    },
  },
  {
    path: ['clipboard', 'push'],
    summary: 'Set this device clipboard from the K12 tx-clipboard buffer',
    run: async ({ args, request, write, clipboard }) => {
      if (positionalOnly(args).length) throw new Error('usage: tx clipboard push');
      const local = clipboard();
      const raw = await request('POST', '/ctl/clipboard/push', {
        schema_version: SCHEMA_VERSION,
        buffer_name: CLIPBOARD_BUFFER_NAME,
      }, { sensitive: true, maxResponseBytes: MAX_CLIPBOARD_BASE64_CHARS + 4096 });
      const parsed = ClipboardPushResponseSchema.safeParse(raw);
      if (!parsed.success) throw new Error('txd returned invalid clipboard response');
      const response = parsed.data;
      await local.set(decodedPush(response));
      write({ ok: true, target: response.target, direction: 'push', local: local.target, bytes: response.bytes });
      return 0;
    },
  },
  {
    path: ['clipboard', 'pull'],
    summary: 'Load this device clipboard into the K12 tx-clipboard buffer',
    run: async ({ args, request, write, clipboard }) => {
      if (positionalOnly(args).length) throw new Error('usage: tx clipboard pull');
      const local = clipboard();
      const content = await local.get();
      const bytes = new TextEncoder().encode(content);
      if (!content.isWellFormed()) throw new Error('local clipboard is not valid UTF-8');
      if (bytes.byteLength > MAX_CLIPBOARD_BYTES) throw new Error('local clipboard exceeds 1 MiB');
      const raw = await request('POST', '/ctl/clipboard/pull', {
        schema_version: SCHEMA_VERSION,
        content,
      }, { sensitive: true, maxResponseBytes: 4096 });
      const parsed = ClipboardPullResponseSchema.safeParse(raw);
      if (!parsed.success) throw new Error('txd returned invalid clipboard response');
      const response = parsed.data;
      if (response.bytes !== bytes.byteLength || response.buffer_name !== CLIPBOARD_BUFFER_NAME) {
        throw new Error('txd returned inconsistent clipboard receipt');
      }
      write({ ok: true, target: response.target, direction: 'pull', local: local.target, bytes: response.bytes });
      return 0;
    },
  },
  {
    path: ['estate', 'compact-events'],
    summary: 'Archive-attested compaction through a reset journal head',
    run: async ({ args, request, write }) => {
      const usage = 'usage: tx estate compact-events reset-journal-head=<seq> archive-attestation="<snapshot=path;restore-proof=journal.head=seq>"';
      const parsed = parseInvocation(args, ['reset-journal-head', 'archive-attestation']);
      const rawResetJournalHead = parsed.params['reset-journal-head'];
      const archiveAttestation = parsed.params['archive-attestation'];
      const resetJournalHead = rawResetJournalHead && /^[1-9][0-9]*$/.test(rawResetJournalHead)
        ? Number(rawResetJournalHead)
        : undefined;
      if (parsed.args.length || parsed.content !== undefined) throw new Error(usage);
      if (!Number.isSafeInteger(resetJournalHead) || !archiveAttestation) throw new Error(usage);
      write(await request('POST', '/ctl/estate/compact-events', {
        schema_version: SCHEMA_VERSION,
        source_agent_id: agentSource('estate compact-events'),
        reset_journal_head: resetJournalHead,
        archive_attestation: archiveAttestation,
      }));
      return 0;
    },
  },
  {
    path: ['estate', 'show'],
    summary: 'Show estate generation, compatibility, and seats',
    run: async ({ args, request, write }) => {
      if (positionalOnly(args).length) throw new Error('usage: tx estate show');
      write(await request('GET', '/tmux/read/estate'));
      return 0;
    },
  },
  {
    path: ['estate', 'zombies'],
    summary: 'List remote envelopes no live binding accounts for',
    run: async ({ args, request, write }) => {
      if (positionalOnly(args).length) throw new Error('usage: tx estate zombies');
      write(await request('GET', '/tmux/read/zombies'));
      return 0;
    },
  },
  {
    path: ['estate', 'reconcile'],
    summary: 'Observe and non-destructively reconcile the estate',
    run: async ({ args, request, write }) => {
      if (positionalOnly(args).length) throw new Error('usage: tx estate reconcile');
      write(await request('POST', '/ctl/reconcile', {}));
      return 0;
    },
  },
  {
    path: ['estate', 'abandon'],
    summary: 'Attest already-flagged absent, unbound noncanonical seats abandoned',
    run: async ({ args, request, write }) => {
      const positional = positionalOnly(args);
      if (positional.length === 0) {
        throw new Error('usage: tx estate abandon <seat> [<seat> ...]');
      }
      const response = await request('POST', '/ctl/estate/abandon', {
        schema_version: SCHEMA_VERSION,
        source_agent_id: agentSource('estate abandon'),
        seats: positional,
      }) as { ok: boolean };
      write(response);
      return response.ok ? 0 : 1;
    },
  },
  {
    path: ['estate', 'event'],
    summary: 'Forward a tmux pane lifecycle event to txd',
    run: async ({ args, request, write }) => {
      const parsed = parseInvocation(args, ['page']);
      const event = parsed.args[0];
      const usage = 'usage: tx estate event <pane-died | pane-exited> page=<page> | tx estate event pane-killed';
      if (event === 'pane-killed') {
        if (parsed.args.length !== 1 || Object.keys(parsed.params).length || parsed.content !== undefined) throw new Error(usage);
        write(await request('POST', '/ingress/tmux', { schema_version: SCHEMA_VERSION, event }));
        return 0;
      }
      if ((event !== 'pane-died' && event !== 'pane-exited') || parsed.args.length !== 1 || parsed.content !== undefined) {
        throw new Error(usage);
      }
      const page = parsed.params.page;
      if (!page) throw new Error('page= requires a page name');
      write(await request('POST', '/ingress/tmux', { schema_version: SCHEMA_VERSION, event, page }));
      return 0;
    },
  },
  {
    path: ['estate', 'rotate'],
    summary: 'Explicitly reset the whole estate, one page, or one pane',
    run: async ({ args, request, write }) => {
      const parsed = parseInvocation(args, ['force', 'page', 'pane']);
      const force = booleanParameter(parsed, 'force');
      const page = parsed.params.page;
      const pane = parsed.params.pane;
      const usage = 'usage: tx estate rotate [force=true] [page=<page> | pane=<canonical-pane>]';
      if (parsed.args.length || parsed.content !== undefined || page === '' || pane === '' || (page && pane)) throw new Error(usage);
      write(await request('POST', '/ctl/estate/rotate', {
        schema_version: SCHEMA_VERSION,
        force,
        scope: page ? 'page' : pane ? 'pane' : 'estate',
        ...(page ? { page } : {}),
        ...(pane ? { pane } : {}),
      }));
      return 0;
    },
  },
];
