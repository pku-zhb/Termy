type FsModule = typeof import('fs');
type OsModule = typeof import('os');
type ChildProcessModule = typeof import('child_process');

export interface AgentCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AgentCommandOptions {
  timeoutMs?: number;
  stdin?: string;
  closeStdinAfterMs?: number;
  environment?: Record<string, string>;
}

export interface AgentStatusRuntime {
  platform: NodeJS.Platform;
  homeDir: string;
  runCommand(
    executable: string,
    args: string[],
    options?: AgentCommandOptions,
  ): Promise<AgentCommandResult | null>;
  fileExists(path: string): Promise<boolean>;
  readTextFile(path: string): Promise<string | null>;
  readDir(path: string): Promise<string[] | null>;
}

export function createElectronAgentStatusRuntime(): AgentStatusRuntime {
  const fs = window.require('fs') as FsModule;
  const os = window.require('os') as OsModule;
  const childProcess = window.require('child_process') as ChildProcessModule;

  return {
    platform: process.platform,
    homeDir: os.homedir(),
    runCommand: (executable, args, options) => runCommand(childProcess, executable, args, options),
    fileExists: (path) => Promise.resolve(fs.existsSync(path)),
    readTextFile: async (path) => {
      try {
        return await fs.promises.readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    readDir: async (path) => {
      try {
        return await fs.promises.readdir(path);
      } catch {
        return null;
      }
    },
  };
}

function runCommand(
  childProcess: ChildProcessModule,
  executable: string,
  args: string[],
  options: AgentCommandOptions = {},
): Promise<AgentCommandResult | null> {
  return new Promise((resolve) => {
    let child: import('child_process').ChildProcess | null = null;
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeoutMs = options.timeoutMs ?? 5000;

    const settle = (result: AgentCommandResult | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      resolve(result);
    };

    const timeout = window.setTimeout(() => {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      settle(null);
    }, timeoutMs);

    try {
      child = childProcess.spawn(executable, args, {
        env: options.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      settle(null);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', () => settle(null));
    child.on('close', (code) => {
      settle({
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.write(options.stdin);
      const close = () => {
        if (!child?.stdin?.destroyed) {
          child?.stdin?.end();
        }
      };
      if (options.closeStdinAfterMs && options.closeStdinAfterMs > 0) {
        window.setTimeout(close, options.closeStdinAfterMs);
      } else {
        close();
      }
    } else {
      child.stdin?.end();
    }
  });
}
