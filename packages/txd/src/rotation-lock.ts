import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface EstateRotationBarrier {
  begin(): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

export const NOOP_ROTATION_BARRIER: EstateRotationBarrier = {
  async begin() {},
  async complete() {},
  async abort() {},
};

/**
 * Holds an advisory flock in a small handoff process. txd.service deliberately
 * uses KillMode=process, so the holder survives the retiring daemon generation.
 * The reconstructed generation releases it only after the canonical estate and
 * completion audit event exist. Attach clients therefore get one kernel-backed,
 * event-driven boundary across the otherwise process-less restart gap.
 */
export class ProcessEstateRotationBarrier implements EstateRotationBarrier {
  constructor(private lockFile: string, private signalFifo: string) {}

  async begin(): Promise<void> {
    await mkdir(dirname(this.lockFile), { recursive: true, mode: 0o700 });
    if (await Bun.file(this.signalFifo).exists()) throw new Error('estate rotation barrier already active');
    const holder = Bun.spawn([
      '/usr/bin/flock', this.lockFile, '/bin/sh', '-c',
      '/usr/bin/mkfifo -m 600 "$1" && printf "locked\\n" && IFS= read -r _ < "$1"',
      'rotation-guard', this.signalFifo,
    ], { stdout: 'pipe', stderr: 'inherit' });
    holder.unref();
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    if (first.done || new TextDecoder().decode(first.value).trim() !== 'locked') {
      await this.abort();
      throw new Error('estate rotation barrier failed to acquire');
    }
  }

  async complete(): Promise<void> {
    if (!(await Bun.file(this.signalFifo).exists())) return;
    const release = Bun.spawn(['/bin/sh', '-c', 'printf "complete\\n" > "$1"', 'rotation-release', this.signalFifo]);
    if (await release.exited !== 0) throw new Error('failed to release estate rotation barrier');
    await unlink(this.signalFifo);
  }

  async abort(): Promise<void> {
    await this.complete();
  }
}
