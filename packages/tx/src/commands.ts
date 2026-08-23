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

function agentSource(verb: string): string {
  const value = process.env.AGENT_ID;
  if (!value) throw new Error(`AGENT_ID is required for tx ${verb}`);
  return value;
}

async function comm({ args, request, write }: CommandContext): Promise<number> {
  let ask = false;
  let page: string | undefined;
  let reply = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if ((page || reply) && positional.length === 0) {
      positional.push(...args.slice(index));
      break;
    }
    const arg = args[index]!;
    if (arg === '--ask') ask = true;
    else if (arg === '--self') positional.push(arg);
    else if (arg === '--reply') reply = true;
    else if (arg === '--page') {
      page = args[++index];
      if (!page) throw new Error('--page requires a page name');
    } else if (arg.startsWith('-') && positional.length === 0) throw new Error(`unknown comm option: ${arg}`);
    else {
      positional.push(...args.slice(index));
      break;
    }
  }
  const intentToken = !reply && !page ? positional[1] : undefined;
  const intentMatch = intentToken?.match(/^(command|skill)=(.*)$/);
  let intent: { kind: 'command' | 'skill'; name: string; args: string[] } | undefined;
  if ((page || reply) && positional.some((value) => /^(command|skill)=/.test(value))) {
    throw new Error('command and skill intents require one direct target');
  }
  if (intentMatch) {
    if (ask || positional.length > 2 && positional[2] !== '--') {
      throw new Error('usage: tx comm <identity> command=<name> [-- args] | tx comm <identity> skill=<name> [-- args]');
    }
    const name = intentMatch[2]!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name)) {
      throw new Error('command and skill names never include /, $, whitespace, or an engine selector');
    }
    intent = { kind: intentMatch[1] as 'command' | 'skill', name, args: positional.slice(3) };
  }
  if (reply) {
    if (page || ask || positional.length !== 1) throw new Error('usage: tx comm --reply <message>');
  } else if (page) {
    if (positional.length !== 1) throw new Error('usage: tx comm [--ask] --page <page> <message>');
  } else if (!intent && positional.length !== 2) throw new Error('usage: tx comm [--ask] <identity> <message>');
  const accepted = await request('POST', '/agents/comm', {
    schema_version: SCHEMA_VERSION, source_agent_id: agentSource('comm'),
    ...(intent ? { intent } : { message: positional.at(-1)! }), ask, reply,
    ...(page ? { page } : {}), ...(!page && !reply ? { target: positional[0] } : {}),
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
  { path: ['comm'], summary: '<identity> command=<name>|skill=<name> [-- args]; caller supplies no /, $, or engine flag', run: comm },
  {
    path: ['inspect', 'hooks'],
    summary: 'Read bounded txd-owned tmux hook diagnostics from the system journal',
    run: async ({ args, request, write }) => {
      let limit = 100;
      if (args.length > 0) {
        if (args.length !== 2 || args[0] !== '--limit' || !/^[0-9]+$/.test(args[1]!)) {
          throw new Error('usage: tx inspect hooks [--limit <1-1000>]');
        }
        limit = Number(args[1]);
      }
      if (limit < 1 || limit > 1000) throw new Error('usage: tx inspect hooks [--limit <1-1000>]');
      const parsed = HookDiagnosticsResponseSchema.safeParse(
        await request('GET', `/tmux/read/diagnostics/hooks?limit=${limit}`),
      );
      if (!parsed.success) throw new Error('txd returned invalid hook diagnostics');
      write(parsed.data);
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
      const messageId = args[0];
      if (!messageId || args.length > 1) throw new Error('usage: tx comm delivery <message-id>');
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
      if (args.length !== 2 || args[0]!.startsWith('-')) throw new Error('usage: tx run <target> <command>');
      const result = await request('POST', '/agents/run', {
        schema_version: SCHEMA_VERSION,
        target: args[0],
        command: args[1],
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
      const usage = 'usage: tx close <target> [<target> ...] [--force] | tx close --page <page> | tx close --all-idle';
      let force = false;
      let page: string | undefined;
      let allIdle = false;
      const targets: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === '--force' && !force) force = true;
        else if (arg === '--page' && page === undefined) {
          page = args[++index];
          if (!page) throw new Error('--page requires a page name');
        } else if (arg === '--all-idle' && !allIdle) allIdle = true;
        else if (arg.startsWith('-')) throw new Error(usage);
        else targets.push(arg);
      }
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
      const action = args[0];
      let target: string | undefined;
      let trigger: 'operator' | 'preplan' | 'context_cycle' = 'operator';
      for (let index = 1; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--target' && target === undefined) {
          const value = args[++index];
          if (!value || value.startsWith('--')) {
            throw new Error('--target requires a logical identity');
          }
          target = value;
        } else if (arg === '--trigger' && trigger === 'operator') {
          const value = args[++index];
          if (value !== 'preplan' && value !== 'context_cycle') {
            throw new Error('--trigger must be preplan or context_cycle');
          }
          trigger = value;
        } else {
          throw new Error('usage: tx mode <enter | toggle | approve> --target <identity> [--trigger <preplan | context_cycle>]');
        }
      }
      if ((action !== 'enter' && action !== 'toggle' && action !== 'approve') || !target) {
        throw new Error('usage: tx mode <enter | toggle | approve> --target <identity> [--trigger <preplan | context_cycle>]');
      }
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
      if (args.length) throw new Error('usage: tx clipboard push');
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
      if (args.length) throw new Error('usage: tx clipboard pull');
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
    path: ['health'],
    summary: 'Show txd and estate health',
    run: async ({ request, write }) => { write(await request('GET', '/ctl/health')); return 0; },
  },
  {
    path: ['estate', 'compact-events'],
    summary: 'Archive-attested compaction through a reset journal head',
    run: async ({ args, request, write }) => {
      const usage = 'usage: tx estate compact-events --reset-journal-head <seq> --archive-attestation <nas-restore:sha256:digest>';
      let resetJournalHead: number | undefined;
      let archiveAttestation: string | undefined;
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--reset-journal-head' && resetJournalHead === undefined) {
          const raw = args[++index];
          if (!raw || !/^[1-9][0-9]*$/.test(raw)) throw new Error(usage);
          resetJournalHead = Number(raw);
        } else if (arg === '--archive-attestation' && archiveAttestation === undefined) {
          archiveAttestation = args[++index];
          if (!archiveAttestation) throw new Error(usage);
        } else {
          throw new Error(usage);
        }
      }
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
      if (args.length) throw new Error('usage: tx estate show');
      write(await request('GET', '/tmux/read/estate'));
      return 0;
    },
  },
  {
    path: ['estate', 'zombies'],
    summary: 'List remote envelopes no live binding accounts for',
    run: async ({ args, request, write }) => {
      if (args.length) throw new Error('usage: tx estate zombies');
      write(await request('GET', '/tmux/read/zombies'));
      return 0;
    },
  },
  {
    path: ['estate', 'reconcile'],
    summary: 'Observe and non-destructively reconcile the estate',
    run: async ({ args, request, write }) => {
      if (args.length) throw new Error('usage: tx estate reconcile');
      write(await request('POST', '/ctl/reconcile', {}));
      return 0;
    },
  },
  {
    path: ['estate', 'abandon'],
    summary: 'Attest already-flagged absent, unbound noncanonical seats abandoned',
    run: async ({ args, request, write }) => {
      if (args.length === 0 || args.some((arg) => arg.startsWith('-'))) {
        throw new Error('usage: tx estate abandon <seat> [<seat> ...]');
      }
      const response = await request('POST', '/ctl/estate/abandon', {
        schema_version: SCHEMA_VERSION,
        source_agent_id: agentSource('estate abandon'),
        seats: args,
      }) as { ok: boolean };
      write(response);
      return response.ok ? 0 : 1;
    },
  },
  {
    path: ['estate', 'event'],
    summary: 'Forward a tmux pane lifecycle event to txd',
    run: async ({ args, request, write }) => {
      const event = args[0];
      const usage = 'usage: tx estate event <pane-died | pane-exited> --page <page> | tx estate event pane-killed';
      if (event === 'pane-killed') {
        if (args.length !== 1) throw new Error(usage);
        write(await request('POST', '/ingress/tmux', { schema_version: SCHEMA_VERSION, event }));
        return 0;
      }
      if ((event !== 'pane-died' && event !== 'pane-exited') || args[1] !== '--page' || args.length !== 3) {
        throw new Error(usage);
      }
      const page = args[2];
      if (!page) throw new Error('--page requires a page name');
      write(await request('POST', '/ingress/tmux', { schema_version: SCHEMA_VERSION, event, page }));
      return 0;
    },
  },
  {
    path: ['estate', 'rotate'],
    summary: 'Explicitly reset the whole estate, one page, or one pane',
    run: async ({ args, request, write }) => {
      let force = false;
      let page: string | undefined;
      let pane: string | undefined;
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === '--force' && !force) force = true;
        else if (arg === '--page' && page === undefined) {
          page = args[++index];
          if (!page) throw new Error('--page requires a page name');
        } else if (arg === '--pane' && pane === undefined) {
          pane = args[++index];
          if (!pane) throw new Error('--pane requires a canonical pane name');
        } else {
          throw new Error('usage: tx estate rotate [--force] [--page <page> | --pane <canonical-pane>]');
        }
      }
      if (page && pane) throw new Error('usage: tx estate rotate [--force] [--page <page> | --pane <canonical-pane>]');
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
