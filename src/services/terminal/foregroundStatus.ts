import type { ForegroundInfo } from '../server/types';

export type AgentTerminalTabStatus = 'claude' | 'claudex' | 'claude3' | 'codex' | 'codeck';
export type TerminalTabStatus = 'none' | 'tmux' | 'ssh' | AgentTerminalTabStatus;

const AGENT_STATUS_BY_COMMAND: Readonly<Record<string, AgentTerminalTabStatus>> = {
  claude: 'claude',
  'claude-code': 'claude',
  claudex: 'claudex',
  c3: 'claude3',
  claude3: 'claude3',
  codex: 'codex',
  codeck: 'codeck',
};

export function classifyForeground(info: ForegroundInfo | null): TerminalTabStatus {
  if (!info) {
    return 'none';
  }

  return classifyCommandText(info.name, info.cmdline);
}

export function terminalStatusAgentKind(status: TerminalTabStatus): 'claude' | 'codex' | null {
  if (status === 'claude' || status === 'claudex' || status === 'claude3') {
    return 'claude';
  }
  return status === 'codex' ? 'codex' : null;
}

// name = 前台进程 argv[0] 的 basename；context = 完整命令行（后端 KERN_PROCARGS2 读到的 argv）。
// Node CLI 与 Python wrapper 的 argv[0] 是 runtime，因此只检查紧随 runtime 的脚本 token，
// 避免普通参数或文件名中的 agent 名称导致误判。
export function classifyCommandText(name: string, context = ''): TerminalTabStatus {
  const normalizedName = normalizeCommandName(name);
  const directStatus = agentStatusForCommand(normalizedName);
  if (directStatus) {
    return directStatus;
  }

  const tokens = commandTokens(context);
  const contextCommand = normalizeCommandName(tokens[0] ?? '');
  const contextStatus = agentStatusForCommand(contextCommand);
  if (contextStatus) {
    return contextStatus;
  }

  if (isScriptLauncher(contextCommand)) {
    const scriptStatus = agentStatusForCommand(normalizeCommandName(tokens[1] ?? ''));
    if (scriptStatus) {
      return scriptStatus;
    }
  }

  if (normalizedName.includes('tmux')) {
    return 'tmux';
  }
  if (normalizedName.includes('ssh')) {
    return 'ssh';
  }

  return 'none';
}

function agentStatusForCommand(command: string): AgentTerminalTabStatus | null {
  return AGENT_STATUS_BY_COMMAND[command] ?? null;
}

function isScriptLauncher(command: string): boolean {
  return command === 'node' || /^python(?:\d+(?:\.\d+)*)?$/.test(command);
}

function commandTokens(commandLine: string): string[] {
  const matches = commandLine.match(/"[^"]*"|'[^']*'|\S+/g);
  return matches?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
}

function normalizeCommandName(command: string): string {
  return basenameCommand(command)
    .toLowerCase()
    .replace(/\.(?:exe|[cm]?js|py)$/i, '');
}

function basenameCommand(command: string): string {
  const trimmed = command.trim();
  const basename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return basename.replace(/^-+/, '');
}
