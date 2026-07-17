type FsModule = typeof import('fs');
type OsModule = typeof import('os');
type PathModule = typeof import('path');

export type RestorableAgentKind = 'claude' | 'codeck';
export type ClaudeAgentLauncher = 'claude' | 'claude3';

export interface RestoredTerminalTab {
  customName: string | null;
  cwd: string | null;
  agentKind: RestorableAgentKind | null;
  agentLauncher: ClaudeAgentLauncher | null;
  title: string | null;
  updatedAtMs: number;
}

export interface TerminalRestoreSnapshot {
  tabs: RestoredTerminalTab[];
  activeIndex: number;
  updatedAtMs: number;
}

interface TerminalRestoreStoreOptions {
  fs: FsModule;
  path: PathModule;
  homeDir: string;
  hostName: string;
  vaultPath: string;
  now?: () => number;
}

interface RestoreFile {
  version: 1;
  deviceId: string;
  vaults: RestoreVault[];
}

interface RestoreVault {
  vaultPath: string;
  activeIndex: number;
  tabs: RestoredTerminalTab[];
  updatedAtMs: number;
}

const RESTORE_SCHEMA_VERSION = 1;
const MAX_RESTORED_TABS = 30;
const RESTORE_DIR = '.termy';
const RESTORE_FILE = 'terminal-restore.json';

export class TerminalRestoreStore {
  private readonly fs: FsModule;
  private readonly path: PathModule;
  private readonly homeDir: string;
  private readonly deviceId: string;
  private readonly vaultPath: string;
  private readonly now: () => number;

  constructor(options: TerminalRestoreStoreOptions) {
    this.fs = options.fs;
    this.path = options.path;
    this.homeDir = options.homeDir;
    this.deviceId = normalizeString(options.hostName) || 'local';
    this.vaultPath = normalizeString(options.vaultPath) || 'default';
    this.now = options.now ?? Date.now;
  }

  static fromElectron(vaultPath: string): TerminalRestoreStore {
    const fs = window.require('fs') as FsModule;
    const os = window.require('os') as OsModule;
    const path = window.require('path') as PathModule;
    return new TerminalRestoreStore({
      fs,
      path,
      homeDir: os.homedir(),
      hostName: os.hostname(),
      vaultPath,
    });
  }

  getFilePath(): string {
    return this.path.join(this.homeDir, RESTORE_DIR, RESTORE_FILE);
  }

  async loadSnapshot(): Promise<TerminalRestoreSnapshot> {
    const file = await this.readFile();
    const vault = file.vaults.find((entry) => entry.vaultPath === this.vaultPath);
    return normalizeSnapshot(vault);
  }

  async saveSnapshot(snapshot: TerminalRestoreSnapshot): Promise<void> {
    const file = await this.readFile();
    const normalized = normalizeSnapshot(snapshot);
    const nextVault: RestoreVault = {
      vaultPath: this.vaultPath,
      activeIndex: normalized.activeIndex,
      tabs: normalized.tabs,
      updatedAtMs: this.now(),
    };

    const existingIndex = file.vaults.findIndex((entry) => entry.vaultPath === this.vaultPath);
    if (existingIndex === -1) {
      file.vaults.push(nextVault);
    } else {
      file.vaults[existingIndex] = nextVault;
    }
    file.deviceId = this.deviceId;

    await this.writeFile(file);
  }

  async clearSnapshot(): Promise<void> {
    const file = await this.readFile();
    file.vaults = file.vaults.filter((entry) => entry.vaultPath !== this.vaultPath);
    file.deviceId = this.deviceId;
    await this.writeFile(file);
  }

  private async readFile(): Promise<RestoreFile> {
    try {
      const raw = await this.fs.promises.readFile(this.getFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return normalizeRestoreFile(parsed, this.deviceId);
    } catch {
      return emptyRestoreFile(this.deviceId);
    }
  }

  private async writeFile(file: RestoreFile): Promise<void> {
    const restoreDir = this.path.dirname(this.getFilePath());
    await this.fs.promises.mkdir(restoreDir, { recursive: true });
    await this.fs.promises.writeFile(
      this.getFilePath(),
      `${JSON.stringify(normalizeRestoreFile(file, this.deviceId), null, 2)}\n`,
      'utf8',
    );
  }
}

export function hasRestorableAgentTabs(snapshot: TerminalRestoreSnapshot): boolean {
  return snapshot.tabs.some((tab) => tab.agentKind !== null);
}

export function restoredAgentCommand(
  agentKind: RestorableAgentKind,
  agentLauncher: ClaudeAgentLauncher | null,
): string {
  if (agentKind === 'claude') {
    return agentLauncher === 'claude3' ? 'c3 --last agents' : 'claude agents';
  }
  return 'codeck';
}

function emptyRestoreFile(deviceId: string): RestoreFile {
  return {
    version: RESTORE_SCHEMA_VERSION,
    deviceId,
    vaults: [],
  };
}

function normalizeRestoreFile(value: unknown, fallbackDeviceId: string): RestoreFile {
  if (!isRecord(value)) {
    return emptyRestoreFile(fallbackDeviceId);
  }

  const vaults = Array.isArray(value.vaults)
    ? value.vaults
      .map(normalizeVault)
      .filter((vault): vault is RestoreVault => vault !== null)
    : [];

  return {
    version: RESTORE_SCHEMA_VERSION,
    deviceId: normalizeString(value.deviceId) || fallbackDeviceId,
    vaults,
  };
}

function normalizeVault(value: unknown): RestoreVault | null {
  if (!isRecord(value)) {
    return null;
  }
  const vaultPath = normalizeString(value.vaultPath);
  if (!vaultPath) {
    return null;
  }
  const snapshot = normalizeSnapshot(value);
  return {
    vaultPath,
    activeIndex: snapshot.activeIndex,
    tabs: snapshot.tabs,
    updatedAtMs: snapshot.updatedAtMs,
  };
}

function normalizeSnapshot(value: unknown): TerminalRestoreSnapshot {
  if (!isRecord(value)) {
    return {
      tabs: [],
      activeIndex: 0,
      updatedAtMs: 0,
    };
  }

  const tabs = Array.isArray(value.tabs)
    ? value.tabs
      .map(normalizeTab)
      .filter((tab): tab is RestoredTerminalTab => tab !== null)
      .slice(0, MAX_RESTORED_TABS)
    : [];

  const activeIndex = normalizeIndex(value.activeIndex, tabs.length);
  const updatedAtMs = typeof value.updatedAtMs === 'number' && Number.isFinite(value.updatedAtMs)
    ? value.updatedAtMs
    : 0;

  return {
    tabs,
    activeIndex,
    updatedAtMs,
  };
}

function normalizeTab(value: unknown): RestoredTerminalTab | null {
  if (!isRecord(value)) {
    return null;
  }

  const customName = normalizeNullableString(value.customName);
  const cwd = normalizeNullableString(value.cwd);
  const normalizedKind = normalizeAgentKind(value.agentKind);
  const legacyLauncher = normalizeString(value.agentLauncher);
  const agentKind = normalizedKind === 'claude' && legacyLauncher === 'claudex'
    ? null
    : normalizedKind;
  const agentLauncher = agentKind === 'claude'
    ? normalizeClaudeAgentLauncher(value.agentLauncher) ?? 'claude'
    : null;
  const title = normalizeNullableString(value.title);
  const updatedAtMs = typeof value.updatedAtMs === 'number' && Number.isFinite(value.updatedAtMs)
    ? value.updatedAtMs
    : 0;

  if (!customName && !cwd && !agentKind && !title) {
    return null;
  }

  return {
    customName,
    cwd,
    agentKind,
    agentLauncher,
    title,
    updatedAtMs,
  };
}

function normalizeIndex(value: unknown, count: number): number {
  if (count <= 0 || typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(count - 1, Math.trunc(value)));
}

function normalizeAgentKind(value: unknown): RestorableAgentKind | null {
  return value === 'claude' || value === 'codeck' ? value : null;
}

function normalizeClaudeAgentLauncher(value: unknown): ClaudeAgentLauncher | null {
  return value === 'claude' || value === 'claude3' ? value : null;
}

function normalizeNullableString(value: unknown): string | null {
  return normalizeString(value) || null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
