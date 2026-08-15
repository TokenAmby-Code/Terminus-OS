import { expect, test } from 'bun:test';
import { RealTmux, type TmuxCommandResult } from '../src/tmux.ts';

test('behavioral pin: concurrent verified deliveries to one pane are serialized as whole submissions', async () => {
  const buffers = new Map<string, string>();
  let composer = '';
  const submitted: string[] = [];
  const run = async (_socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> => {
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: `> ${composer}\n`, stderr: '' };
    if (args[0] === 'load-buffer') buffers.set(args[2]!, new TextDecoder().decode(stdin));
    if (args[0] === 'paste-buffer') composer += buffers.get(args[args.indexOf('-b') + 1]!) ?? '';
    if (args[0] === 'send-keys' && args.at(-1) === 'Enter') {
      submitted.push(composer);
      composer = '';
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    audit: () => undefined,
    observePaneOutput: async () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) throw new Error('no further pane output');
          emitted = true;
        },
        close: () => undefined,
      };
    },
  });
  const first = '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\nfirst';
  const second = '[tx comm 22222222-2222-4222-8222-222222222222 from sender]\nsecond';

  const outcomes = await Promise.all([
    tmux.sendVerifiedToSeat('palace:S', '11111111-1111-4111-8111-111111111111', first),
    tmux.sendVerifiedToSeat('palace:S', '22222222-2222-4222-8222-222222222222', second),
  ]);

  expect(outcomes.map((outcome) => outcome.verdict)).toEqual(['staged', 'staged']);
  expect(submitted).toEqual([first, second]);
});

// The backoff knob is gone with the retry ladder it paced. A construction
// option is the seam a magic-number timeout would grow back through, so the
// absence is pinned rather than assumed.
test('there is no knob to delay or repeat the submit', () => {
  const source = Bun.file(new URL('../src/tmux.ts', import.meta.url)).text();
  return source.then((text) => {
    expect(text).not.toInclude('enterDelayMs');
    expect(text).not.toInclude('TXD_SEND_ENTER_DELAY_MS');
    expect(text).not.toInclude('verify_submit');
  });
});

test('verified send waits for a pane-output event before observing the composer', async () => {
  const calls: string[] = [];
  let releaseOutput!: () => void;
  let literalStarted!: () => void;
  let pasted = false;
  const output = new Promise<void>((resolve) => { releaseOutput = resolve; });
  const literal = new Promise<void>((resolve) => { literalStarted = resolve; });
  const frame = '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\nhello';
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args[0]!);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'paste-buffer') {
      pasted = true;
      literalStarted();
    }
    if (args[0] === 'capture-pane') return { code: 0, stdout: `> ${pasted ? frame : ''}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async (_socket, paneId) => {
      calls.push(`arm:${paneId}`);
      return { next: async () => output, close: () => { calls.push('close'); } };
    },
  });

  const pending = tmux.sendVerifiedToSeat('palace:S', '11111111-1111-4111-8111-111111111111', frame);
  await literal;
  expect(calls).toEqual(['list-panes', 'capture-pane', 'arm:%7', 'load-buffer', 'paste-buffer']);
  expect(calls.filter((call) => call === 'capture-pane')).toHaveLength(1);

  releaseOutput();
  expect((await pending).verdict).toBe('staged');
  expect(calls).toEqual([
    'list-panes', 'capture-pane', 'arm:%7', 'load-buffer', 'paste-buffer', 'capture-pane', 'send-keys', 'close',
  ]);
});

for (const existing of [
  'operator draft: do not submit',
  '[tx comm 22222222-2222-4222-8222-222222222222 from sender]\nold frame',
  '[Pasted Content 4096 chars]',
  '[Pasted Content 4096\n  chars]',
]) {
  test(`verified send refuses a painted composer before pane input: ${existing.split('\n')[0]}`, async () => {
    const baseline = `transcript\n\n› ${existing}\n\n  gpt-5.6-sol medium`;
    const calls: string[][] = [];
    const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
      if (args[0] === 'capture-pane') return { code: 0, stdout: baseline, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const tmux = new RealTmux('scratch', {
      run,
      observePaneOutput: async () => { throw new Error('dirty composer must refuse before arming'); },
    });

    const outcome = await tmux.sendVerifiedToSeat(
      'palace:S',
      '11111111-1111-4111-8111-111111111111',
      '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\nnew frame',
      undefined,
      'codex',
    );

    expect(outcome).toEqual({ bytes: 0, verdict: 'composer_corrupted' });
    expect(calls.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]!))).toHaveLength(0);
    expect(calls.filter((args) => args[0] === 'capture-pane')).toHaveLength(1);
    expect(baseline).toBe(`transcript\n\n› ${existing}\n\n  gpt-5.6-sol medium`);
  });
}

for (const profile of [
  {
    engine: 'codex' as const,
    baseline: 'transcript\n\n› Summarize recent commits\n\n  gpt-5.6-sol medium',
  },
  {
    engine: 'codex' as const,
    baseline: 'transcript\n\n› Use /skills to list available skills\n\n  gpt-5.6-sol medium',
  },
  {
    engine: 'codex' as const,
    baseline: 'transcript\n\n› Check recently modified functions for\n  compatibility\n\n  gpt-5.6-sol medium',
  },
  {
    engine: 'codex' as const,
    baseline: 'transcript\n\n› Use /skills to list av\n\n  gpt-5.6-sol medium',
  },
  {
    engine: 'claude' as const,
    baseline: 'transcript\n\n❯ Try "how does <filepath> work?"\n\n  ? for shortcuts',
  },
]) {
  test(`behavioral pin: ${profile.engine} idle suggestion paint is a known-empty verified-send baseline`, async () => {
    const frame = '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\nnew frame';
    let capture = 0;
    const calls: string[][] = [];
    const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
      if (args[0] === 'capture-pane') {
        capture += 1;
        return { code: 0, stdout: capture === 1 ? profile.baseline : `› ${frame}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const tmux = new RealTmux('scratch', {
      run,
      composerObserveTimeoutMs: 10_000,
      observePaneOutput: async () => ({ next: async () => undefined, close: () => undefined }),
    });

    const outcome = await tmux.sendVerifiedToSeat(
      'palace:S',
      '11111111-1111-4111-8111-111111111111',
      frame,
      undefined,
      profile.engine,
    );

    expect(outcome).toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged' });
    expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(1);
  });
}

test('behavioral pin: verified comm accepts an intact frame clipped inside the Codex composer viewport', () => {
  const messageId = '11111111-1111-4111-8111-111111111111';
  const frame = `[tx comm ${messageId} from sender]\n`
    + 'A long operational brief whose header scrolls above the visible textarea.\n'
    + 'The final lines remain visible and are the exact suffix the editor owns.';
  const pane = [
    '• earlier transcript remains above the composer',
    '',
    '  1 background terminal running · /ps',
    '',
    '› n visible and are the exact suffix',
    '  the editor owns.',
    '',
    '  gpt-5.6-sol medium · ~/.local/share…',
  ].join('\n');

  expect(RealTmux.composerVerdict(pane, messageId, frame)).toBe('intact');
});

test('behavioral pin: clipped Codex composer suffix must still match exactly', () => {
  const messageId = '11111111-1111-4111-8111-111111111111';
  const frame = `[tx comm ${messageId} from sender]\n`
    + 'A long operational brief whose header scrolls above the visible textarea.\n'
    + 'The final lines remain visible and are the exact suffix the editor owns.';
  const pane = [
    '  1 background terminal running · /ps',
    '',
    '› n visible and are the exact suffix',
    '  the editor is corrupted.',
    '',
    '  gpt-5.6-sol medium · ~/.local/share…',
  ].join('\n');

  expect(RealTmux.composerVerdict(pane, messageId, frame)).toBe('corrupted');
});

test('behavioral pin: an exact new frame appended to stale composer text is corrupted', () => {
  const messageId = '11111111-1111-4111-8111-111111111111';
  const frame = `[tx comm ${messageId} from sender]\nnew frame`;
  const pane = `› stale draft\n  ${frame}`;

  expect(RealTmux.composerVerdict(pane, messageId, frame)).toBe('corrupted');
  expect(RealTmux.inputVerdict('› stale draft\n  machine input', 'machine input')).toBe('corrupted');
});

test('behavioral pin: Codex collapsed-paste receipt verifies an exact multi-KB frame count', () => {
  const messageId = '11111111-1111-4111-8111-111111111111';
  const frame = `[tx comm ${messageId} from sender]\n`
    + `${'0123456789'.repeat(450)}\nquotes: 'single' "double" $dollar \\ slash\nUnicode: Ω 漢字 🛡️`;
  const scalarCount = [...frame].length;
  const pane = [
    '• earlier transcript remains above the composer',
    '',
    `› [Pasted Content ${scalarCount}`,
    '  chars]',
    '',
    '  gpt-5.6-sol medium · ~/.local/share…',
  ].join('\n');

  expect(RealTmux.composerVerdict(pane, messageId, frame)).toBe('intact');
  expect(RealTmux.composerVerdict(
    pane.replace(String(scalarCount), String(scalarCount - 1)),
    messageId,
    frame,
  )).toBe('corrupted');
});

for (const receipt of [
  (count: number) => `› [Pasted Content ${count} chars]\n`,
  (count: number) => `› [Pasted Content ${count}\n  chars]\n`,
]) {
  test('verified send accepts an exact Codex paste receipt only from an empty baseline', async () => {
    const frame = '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\n' + 'x'.repeat(4096);
    const baseline = 'transcript\n\n› \n\n  gpt-5.6-sol medium';
    let capture = 0;
    const calls: string[][] = [];
    const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
      if (args[0] === 'capture-pane') {
        capture += 1;
        return { code: 0, stdout: capture === 1 ? baseline : receipt([...frame].length), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const tmux = new RealTmux('scratch', {
      run,
      composerObserveTimeoutMs: 10_000,
      observePaneOutput: async () => ({ next: async () => undefined, close: () => undefined }),
    });

    const outcome = await tmux.sendVerifiedToSeat(
      'palace:S',
      '11111111-1111-4111-8111-111111111111',
      frame,
    );

    expect(outcome).toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged' });
    expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(1);
  });
}

test('behavioral pin: a transcript prompt above active assistant output is not an interactive composer', () => {
  const pane = [
    '› prior operator prompt',
    '',
    '• still working on the current turn',
    '',
    '  gpt-5.6-sol medium · ~/.local/share…',
  ].join('\n');

  expect(RealTmux.composerInteractive(pane)).toBe(false);
});

test('verified send never submits when output settles without the expected frame', async () => {
  const calls: string[][] = [];
  let capture = 0;
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'capture-pane') {
      capture += 1;
      return { code: 0, stdout: capture === 1 || capture === 3 ? '> \n' : '> unrelated text\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) throw new Error('observation complete');
          emitted = true;
        },
        close: () => undefined,
      };
    },
  });

  const outcome = await tmux.sendVerifiedToSeat('palace:S', 'correlation', 'machine input');

  expect(outcome.verdict).toBe('composer_corrupted');
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(0);
});

test('behavioral pin: verified send transports an adversarial multi-KB frame as one bracketed paste', async () => {
  const calls: Array<{ args: string[]; stdin?: Uint8Array }> = [];
  const frame = '[tx comm 11111111-1111-4111-8111-111111111111 from sender]\n'
    + `${'0123456789'.repeat(700)}\nquotes: 'single' "double" $dollar \\ slash\nUnicode: Ω 漢字 🛡️`;
  let composer = '';
  let loaded = '';
  const run = async (_socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> => {
    calls.push(stdin === undefined ? { args } : { args, stdin });
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'load-buffer') {
      loaded = new TextDecoder().decode(stdin);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'paste-buffer') {
      composer += loaded;
      loaded = '';
      return { code: 0, stdout: '', stderr: '' };
    }
    // This models the live Codex failure: one send-keys literal burst loses
    // everything after codepoint 523 while tmux itself exits zero.
    if (args[0] === 'send-keys' && args.includes('-l')) {
      composer += [...args.at(-1)!].slice(0, 523).join('');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'capture-pane') return { code: 0, stdout: `› ${composer}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) throw new Error('observation complete');
          emitted = true;
        },
        close: () => undefined,
      };
    },
  });

  const outcome = await tmux.sendVerifiedToSeat(
    'palace:S',
    '11111111-1111-4111-8111-111111111111',
    frame,
  );

  expect(outcome).toEqual({ bytes: Buffer.byteLength(frame), verdict: 'staged' });
  expect(composer).toBe(frame);
  expect(calls.filter(({ args }) => args[0] === 'send-keys' && args.includes('-l'))).toHaveLength(0);
  const load = calls.find(({ args }) => args[0] === 'load-buffer');
  expect(new TextDecoder().decode(load?.stdin)).toBe(frame);
  expect(load?.args).toEqual(['load-buffer', '-b', expect.stringMatching(/^txd-input-/), '-']);
  expect(calls.find(({ args }) => args[0] === 'paste-buffer')?.args).toEqual([
    'paste-buffer', '-p', '-r', '-d', '-b', expect.stringMatching(/^txd-input-/), '-t', '%7',
  ]);
  expect(calls.filter(({ args }) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(1);
});

for (const length of [522, 523, 524, 4096]) {
  test(`behavioral pin: exact ${length}-codepoint verified frame is never prefix-truncated`, async () => {
    const frame = 'x'.repeat(length);
    let loaded = '';
    let composer = '';
    const run = async (_socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> => {
      if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
      if (args[0] === 'load-buffer') {
        loaded = new TextDecoder().decode(stdin);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'paste-buffer') {
        composer += loaded;
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'send-keys' && args.includes('-l')) {
        composer += [...args.at(-1)!].slice(0, 523).join('');
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'capture-pane') return { code: 0, stdout: `› ${composer}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const tmux = new RealTmux('scratch', {
      run,
      composerObserveTimeoutMs: 10_000,
      observePaneOutput: async () => {
        let emitted = false;
        return {
          next: async () => {
            if (emitted) throw new Error('observation complete');
            emitted = true;
          },
          close: () => undefined,
        };
      },
    });

    expect((await tmux.sendVerifiedToSeat('palace:S', 'correlation', frame)).verdict).toBe('staged');
    expect(composer).toBe(frame);
  });
}

test('behavioral pin: a failed bulk paste submits no prefix and fails loudly', async () => {
  const calls: string[][] = [];
  let composer = '';
  const run = async (_socket: string, args: string[]): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'load-buffer') return { code: 0, stdout: '', stderr: '' };
    if (args[0] === 'paste-buffer') return { code: 1, stdout: '', stderr: 'target pane vanished' };
    if (args[0] === 'capture-pane') return { code: 0, stdout: `› ${composer}\n`, stderr: '' };
    if (args[0] === 'send-keys' && args.includes('-l')) composer += args.at(-1)!;
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) throw new Error('observation complete');
          emitted = true;
        },
        close: () => undefined,
      };
    },
  });

  const outcome = await tmux.sendVerifiedToSeat('palace:S', 'correlation', 'x'.repeat(4096));

  expect(outcome).toEqual({ bytes: 0, verdict: 'seat_unresolved' });
  expect(composer).toBe('');
  expect(calls.some((args) => args[0] === 'delete-buffer')).toBe(true);
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(0);
});

test('behavioral pin: a failed verified send attests byte-identical restoration to its empty baseline', async () => {
  const baseline = 'transcript keeps $ and unicode Ω\n\n> \n\nfooter';
  const injected = '[lcd event lane2.transport_proof seq=227817]\n{"nonce":"one-event"}';
  let composer = '';
  let loaded = '';
  let capture = 0;
  const calls: string[][] = [];
  const run = async (_socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> => {
    calls.push(args);
    if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
    if (args[0] === 'load-buffer') {
      loaded = new TextDecoder().decode(stdin);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'paste-buffer') {
      composer += loaded;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'send-keys' && args.includes('BSpace')) {
      const count = Number(args[args.indexOf('-N') + 1]);
      composer = [...composer].slice(0, -count).join('');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'capture-pane') {
      capture += 1;
      if (capture === 1 || composer === '') return { code: 0, stdout: baseline, stderr: '' };
      // The terminal repainted before the last inserted codepoint. This is a
      // corrupted-paint exhibit while the editor still owns the complete
      // atomic paste and can undo exactly that suffix.
      return { code: 0, stdout: `> ${composer.slice(0, -1)}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const tmux = new RealTmux('scratch', {
    run,
    composerObserveTimeoutMs: 10_000,
    observePaneOutput: async () => {
      let emitted = false;
      return {
        next: async () => {
          if (emitted) throw new Error('observation complete');
          emitted = true;
        },
        close: () => undefined,
      };
    },
  });

  const outcome = await tmux.sendVerifiedToSeat('palace:S', 'correlation', injected);

  expect(outcome.verdict).toBe('composer_corrupted');
  expect(composer).toBe('');
  expect(calls.filter((args) => args[0] === 'load-buffer')).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'paste-buffer')).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'send-keys' && args.includes('BSpace'))).toHaveLength(1);
  expect(calls.filter((args) => args[0] === 'send-keys' && args.at(-1) === 'Enter')).toHaveLength(0);
  expect(calls.filter((args) => args[0] === 'capture-pane')).toHaveLength(3);
});

for (const profile of [
  { engine: 'claude', prefix: '/compact', suffix: ' hard', chrome: '╭─ commands ─╮\n│ /compact     │\n╰───────────────╯' },
  { engine: 'codex', prefix: '$openai-docs', suffix: ' models', chrome: 'skills\n  $openai-docs\n  $skill-creator' },
] as const) {
  test(`behavioral pin: ${profile.engine} palette chrome cannot corrupt or complete a full-name intent`, async () => {
    const calls: string[][] = [];
    let composer = '';
    let loaded = '';
    const expected = profile.prefix + profile.suffix;
    const run = async (_socket: string, args: string[], stdin?: Uint8Array): Promise<TmuxCommandResult> => {
      calls.push(args);
      if (args[0] === 'list-panes') return { code: 0, stdout: '%7\tpalace:S\n', stderr: '' };
      if (args[0] === 'load-buffer') {
        loaded = new TextDecoder().decode(stdin);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'paste-buffer') {
        composer += loaded;
        loaded = '';
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'send-keys' && args.at(-1) === 'Tab') {
        // The real-profile hypothesis being pinned: after the complete name,
        // Tab commits/collapses selection without changing editor bytes.
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'capture-pane') return { code: 0, stdout: `${profile.chrome}\n› ${composer}\n`, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const tmux = new RealTmux('scratch', {
      run,
      composerObserveTimeoutMs: 10_000,
      observePaneOutput: async () => ({ next: async () => undefined, close: () => undefined }),
    });

    const outcome = await tmux.sendVerifiedToSeat('palace:S', 'correlation', expected, profile.prefix);

    expect(outcome).toEqual({ bytes: Buffer.byteLength(expected), verdict: 'staged' });
    expect(composer).toBe(expected);
    expect(calls.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]!))
      .map((args) => args[0] === 'send-keys' ? args.at(-1) : args[0])).toEqual([
        'load-buffer', 'paste-buffer', 'Tab', 'load-buffer', 'paste-buffer', 'Enter',
      ]);
  });
}
