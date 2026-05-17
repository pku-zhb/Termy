/**
 * Lightweight detection for whether an executable is available on the user's PATH.
 *
 * Used by the workflow launcher menu to render readiness badges:
 *  - 'ready'         → executable resolves on PATH
 *  - 'not-installed' → resolver returned a non-zero status
 *  - 'unknown'       → resolver failed for an unexpected reason (timeout, spawn error)
 *
 * Detection only spawns the platform's standard PATH resolver (`where` / `which`).
 * It never executes the target command, never auto-installs anything, and never
 * touches the network — it is purely informational.
 */

import { debugWarn } from '../../utils/logger.ts';

export type CommandAvailability = 'ready' | 'not-installed' | 'unknown';

interface CacheEntry {
  result: CommandAvailability;
  expiresAt: number;
}

const CACHE_TTL_MS = 5_000;
const DETECT_TIMEOUT_MS = 1_500;

const cache = new Map<string, CacheEntry>();

interface ChildProcessLike {
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
  kill(): void;
}

interface NodeChildProcess {
  spawn: (command: string, args: string[], options: Record<string, unknown>) => ChildProcessLike;
}

/**
 * Detect whether an executable is reachable from the current PATH.
 * Results are cached for a few seconds so menu re-opens are cheap.
 */
export function detectCommandAvailability(command: string): Promise<CommandAvailability> {
  const trimmed = command.trim();
  if (!trimmed) {
    return Promise.resolve('unknown');
  }

  const cached = cache.get(trimmed);
  if (cached && cached.expiresAt > Date.now()) {
    return Promise.resolve(cached.result);
  }

  return runDetection(trimmed).then((result) => {
    cache.set(trimmed, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  });
}

/**
 * Clear cached detection results. Exposed primarily for tests and explicit refresh
 * actions (e.g. when the user re-runs an install step).
 */
export function clearCommandAvailabilityCache(command?: string): void {
  if (command) {
    cache.delete(command.trim());
  } else {
    cache.clear();
  }
}

function runDetection(command: string): Promise<CommandAvailability> {
  return new Promise((resolve) => {
    let childProcess: NodeChildProcess;
    try {
      childProcess = window.require('child_process') as NodeChildProcess;
    } catch (error) {
      debugWarn('[commandAvailability] child_process is unavailable:', error);
      resolve('unknown');
      return;
    }

    const isWindows = process.platform === 'win32';
    const resolver = isWindows ? 'where' : 'which';

    let proc: ChildProcessLike;
    try {
      proc = childProcess.spawn(resolver, [command], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      debugWarn(`[commandAvailability] failed to spawn ${resolver}:`, error);
      resolve('unknown');
      return;
    }

    let settled = false;
    const settle = (result: CommandAvailability) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = window.setTimeout(() => {
      try {
        proc.kill();
      } catch (error) {
        debugWarn('[commandAvailability] failed to kill detector process:', error);
      }
      settle('unknown');
    }, DETECT_TIMEOUT_MS);

    proc.on('error', () => {
      window.clearTimeout(timer);
      settle('unknown');
    });

    proc.on('exit', (code) => {
      window.clearTimeout(timer);
      settle(code === 0 ? 'ready' : 'not-installed');
    });
  });
}
