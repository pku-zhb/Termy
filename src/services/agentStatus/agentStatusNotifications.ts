import type { AgentClient, AgentSnapshot } from './types.ts';

export type AgentDisplayState = 'green' | 'red' | 'white';
export type AgentStatusTransition = 'green-to-white' | 'green-to-red';

export interface AgentStatusNotification {
  title: string;
  body: string;
  transition: AgentStatusTransition;
}

export interface AgentStatusNotifier {
  notify(notification: AgentStatusNotification): void | Promise<void>;
}

export function resolveAgentDisplayState(snapshot: AgentSnapshot): AgentDisplayState {
  if (snapshot.summary.waitingApproval > 0) {
    return 'red';
  }
  if (snapshot.summary.running > 0) {
    return 'green';
  }
  return 'white';
}

export function resolveAgentStatusTransition(
  previous: AgentDisplayState | null,
  next: AgentDisplayState,
): AgentStatusTransition | null {
  if (previous === 'green' && next === 'white') {
    return 'green-to-white';
  }
  if (previous === 'green' && next === 'red') {
    return 'green-to-red';
  }
  return null;
}

export function createAgentStatusNotification(
  transition: AgentStatusTransition,
  snapshot: AgentSnapshot,
): AgentStatusNotification {
  if (transition === 'green-to-red') {
    const waitingClients = snapshot.clients.filter((client) => client.state === 'waitingApproval');
    return {
      title: 'Termy Agent 需要处理',
      body: waitingClients.length > 0
        ? waitingClients.map(formatClientLabel).join('\n')
        : 'Agent 已从运行转为等待处理',
      transition,
    };
  }

  return {
    title: 'Termy Agent 已完成',
    body: 'Agent 已从运行转为空闲',
    transition,
  };
}

export class BrowserAgentStatusNotifier implements AgentStatusNotifier {
  private readonly platform: NodeJS.Platform;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  async notify(notification: AgentStatusNotification): Promise<void> {
    if (this.platform !== 'darwin') {
      return;
    }

    const NotificationCtor = globalThis.Notification;
    if (!NotificationCtor) {
      return;
    }

    let permission = NotificationCtor.permission;
    if (permission === 'default') {
      permission = await NotificationCtor.requestPermission();
    }
    if (permission !== 'granted') {
      return;
    }

    new NotificationCtor(notification.title, {
      body: notification.body,
      silent: false,
    });
  }
}

function formatClientLabel(client: AgentClient): string {
  const agent = client.kind === 'claude' ? 'Claude' : 'Codex';
  const location = client.cwd ? ` - ${client.cwd}` : '';
  return `${agent} pid ${client.pid}${location}`;
}
