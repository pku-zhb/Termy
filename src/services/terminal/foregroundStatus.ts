import type { ForegroundInfo } from '../server/types';

export type TerminalTabStatus = 'none' | 'tmux' | 'ssh' | 'claude' | 'codex';

export function classifyForeground(info: ForegroundInfo | null): TerminalTabStatus {
  if (!info) {
    return 'none';
  }

  return classifyCommandText(info.name, info.cmdline);
}

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
