import type { ForegroundInfo } from '../server/types';

export type TerminalTabStatus = 'none' | 'tmux' | 'ssh' | 'claude' | 'codex';

export function classifyForeground(info: ForegroundInfo | null): TerminalTabStatus {
  if (!info) {
    return 'none';
  }

  return classifyCommandText(info.name, info.cmdline);
}

// name = 前台进程 argv[0] 的 basename；context = 完整命令行（后端 KERN_PROCARGS2 读到的 argv）。
// ⚠️ `node + context.includes(...)` 不是死代码：codex 是 codex.js、用 `node` 启动，claude 某些
// 安装方式 argv[0] 也是 node —— 它们 argv[0] 的 basename 是 `node`，但命令行里含 codex/claude，
// 必须靠 context 区分。后端必须用 argv（KERN_PROCARGS2）而非 pidpath（只给可执行名，认不出）。
export function classifyCommandText(name: string, context = ''): TerminalTabStatus {
  const normalizedName = basenameCommand(name).toLowerCase();
  const normalizedContext = context.toLowerCase();

  if (normalizedName === 'claude' || (normalizedName === 'node' && normalizedContext.includes('claude'))) {
    return 'claude';
  }
  if (normalizedName === 'codex' || (normalizedName === 'node' && normalizedContext.includes('codex'))) {
    return 'codex';
  }
  if (normalizedName.includes('tmux')) {
    return 'tmux';
  }
  if (normalizedName.includes('ssh')) {
    return 'ssh';
  }

  return 'none';
}

function basenameCommand(command: string): string {
  const trimmed = command.trim();
  const basename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return basename.replace(/^-+/, '');
}
