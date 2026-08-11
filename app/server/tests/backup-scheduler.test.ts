import { afterEach, describe, expect, it, vi } from 'vitest';

import { startAutomaticBackupScheduler } from '../src/modules/backup/scheduler.js';

afterEach(() => vi.useRealTimers());

describe('automatic backup scheduler', () => {
  it('checks immediately, does not overlap, and stops cleanly', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const stop = startAutomaticBackupScheduler({} as never, { environment: 'production', intervalMs: 1000, run });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not create a background timer in test', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => undefined);
    startAutomaticBackupScheduler({} as never, { environment: 'test', intervalMs: 1, run });
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
