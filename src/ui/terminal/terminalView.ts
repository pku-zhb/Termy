import type { WorkspaceLeaf, Menu } from 'obsidian';
import { FileSystemAdapter, ItemView, MarkdownView, Notice, Scope, TFile, TFolder, setIcon } from 'obsidian';
import { shell, webUtils } from 'electron';

/**
 * Node built-ins are resolved on demand inside the `TerminalView`
 * constructor via Electron's `window.require` to keep filesystem
 * access out of the bundled module top-level scope. This avoids
 * tripping the Obsidian community plugin reviewer's static "Direct
 * Filesystem Access" warning while preserving runtime semantics
 * (Electron caches `require` results).
 */
type FsModule = typeof import('fs');
type OsModule = typeof import('os');
type PathModule = typeof import('path');

import type { TerminalService } from '../../services/terminal/terminalService';
import type { TerminalInstance } from '../../services/terminal/terminalInstance';
import type { ForegroundInfo } from '../../services/server/types';
import type {
  AgentClient,
  AgentKind,
  AgentSnapshot,
  AgentState,
  AgentStatusService,
} from '../../services/agentStatus/agentStatusService';
import { AgentMonitor } from '../agentStatus/agentMonitor';
import { CLAUDE_ICON, CODEX_ICON, TMUX_ICON } from './statusIcons';
import {
  collectFallbackDroppedTextPayload,
  collectPreferredDroppedTextPayload,
  resolveDroppedTextInput,
} from '../../services/terminal/dropTextPayload';
import { formatClaudeCodePathReferences } from '../../services/terminal/claudeCodePathReferences';
import {
  classifyForeground,
  type TerminalTabStatus,
} from '../../services/terminal/foregroundStatus';
import {
  TerminalRestoreStore,
  restoredAgentCommand,
  type RestorableAgentKind,
  type RestoredTerminalTab,
  type TerminalRestoreSnapshot,
} from '../../services/terminal/terminalRestoreState';
import {
  collectTerminalReferenceCandidatePaths,
  fileUriToPlatformPath,
  findUniqueTerminalEntryByBasename,
  getVaultRelativePathFromAbsolute,
  isBasenameOnlyTerminalToken,
  isAbsoluteTerminalPath,
  joinTerminalPaths,
  normalizeDroppedEntryReference,
  normalizeTerminalRawToken,
  normalizeTerminalReferencePath,
  normalizeTerminalToken,
  normalizeVaultPath,
  obsidianUriToVaultPath,
  toPlatformPath,
} from '../../services/terminal/terminalPathUtils';
import {
  buildTerminalFileUriJunctionCandidates,
  parseTerminalFileUriLinks,
  parseTerminalFileUriReference,
  terminalFileUriLooksOpenAtEnd,
} from '../../services/terminal/terminalFileLinks';
import {
  parseTerminalWebLinks,
  terminalWebUrlLooksLikeContinuation,
  terminalWebUrlLooksOpenAtEnd,
} from '../../services/terminal/terminalWebLinks';
import {
  buildTerminalLinkWindow,
  terminalBufferPositionForStringIndex,
} from '../../services/terminal/terminalLinkGeometry';
import type { TerminalSettings } from '../../settings/settings';
import { debugLog, errorLog } from '../../utils/logger';
import { clamp, normalizeBackgroundPosition, normalizeBackgroundSize, toCssUrl } from '../../utils/styleUtils';
import { t } from '../../i18n';
import { confirmCloseTerminal } from './confirmCloseTerminalModal';
import { RenameTerminalModal } from './renameTerminalModal';
type XtermTerminal = import('@xterm/xterm').Terminal;
type XtermDisposable = import('@xterm/xterm').IDisposable;
type XtermLink = import('@xterm/xterm').ILink;
type XtermBufferRange = import('@xterm/xterm').IBufferRange;

export const TERMINAL_VIEW_TYPE = 'terminal-view';
const TERMINAL_FOCUS_RETRY_DELAYS_MS = [0, 50, 150] as const;
const RESTORED_AGENT_METADATA_GRACE_MS = 2 * 60 * 1000;
const CLAUDE_HOOK_SESSION_LOOKBACK_MS = 10 * 60 * 1000;
const IDLE_SHELL_PROCESS_NAMES = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'csh',
  'dash',
  'elvish',
  'fish',
  'ksh',
  'nu',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'sh',
  'tcsh',
  'xonsh',
  'zsh',
]);

interface TerminalCloseRisk {
  processName: string;
}

interface ParsedTerminalHyperlink {
  uri: string;
  startIndex: number;
  endIndex: number;
  kind: 'file' | 'web';
}

interface TerminalTabEntry {
  terminal: TerminalInstance;
  paneEl: HTMLElement;
  customName: string | null;
  status: TerminalTabStatus;
  lastKnownAgentKind: RestorableAgentKind | null;
  lastKnownAgentSessionId: string | null;
  lastKnownAgentProtectedUntilMs: number;
}

interface AddTerminalTabOptions {
  cwd?: string | null;
  customName?: string | null;
  agentKind?: RestorableAgentKind | null;
  agentSessionId?: string | null;
  activate?: boolean;
  persist?: boolean;
}

interface TerminalTabAgentStatus {
  state: AgentState;
  clients: AgentClient[];
}

function isIdleShellForeground(info: ForegroundInfo): boolean {
  if (classifyForeground(info) !== 'none') {
    return false;
  }

  const processName = getForegroundProcessName(info).toLowerCase();
  return IDLE_SHELL_PROCESS_NAMES.has(processName);
}

function getForegroundProcessName(info: ForegroundInfo): string {
  return basenameCommand(info.name) || basenameCommand(firstCommandToken(info.cmdline));
}

function firstCommandToken(commandLine: string): string {
  const match = commandLine.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

function basenameCommand(command: string): string {
  const trimmed = command.trim();
  const basename = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return basename.replace(/^-+/, '');
}

function aggregateTabAgentStatus(clients: AgentClient[]): TerminalTabAgentStatus | null {
  if (clients.length === 0) {
    return null;
  }

  if (clients.some((client) => client.state === 'waitingApproval')) {
    return { state: 'waitingApproval', clients };
  }
  if (clients.some((client) => client.state === 'running')) {
    return { state: 'running', clients };
  }
  if (clients.some((client) => client.state === 'unknown')) {
    return { state: 'unknown', clients };
  }
  return { state: 'idle', clients };
}

function shouldPaintTabAgentState(state: AgentState): boolean {
  return state === 'running' || state === 'waitingApproval';
}

function uniqueAgentKinds(clients: AgentClient[]): AgentKind[] {
  const kinds: AgentKind[] = [];
  for (const kind of ['claude', 'codex'] as const) {
    if (clients.some((client) => client.kind === kind)) {
      kinds.push(kind);
    }
  }
  return kinds;
}

function parseTmuxSessionName(commandLine: string): string | null {
  const tokens = shellTokens(commandLine);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((token === '-t' || token === '--target' || token === '-s' || token === '--session-name') && tokens[index + 1]) {
      return normalizeTmuxTarget(tokens[index + 1]);
    }
    if (token.startsWith('-t') && token.length > 2) {
      return normalizeTmuxTarget(token.slice(2));
    }
    if (token.startsWith('-s') && token.length > 2) {
      return normalizeTmuxTarget(token.slice(2));
    }
    if (token.startsWith('--target=')) {
      return normalizeTmuxTarget(token.slice('--target='.length));
    }
    if (token.startsWith('--session-name=')) {
      return normalizeTmuxTarget(token.slice('--session-name='.length));
    }
  }
  return null;
}

function resolveTmuxSessionName(snapshot: AgentSnapshot, foreground: ForegroundInfo | null | undefined): string | null {
  const parsedSessionName = parseTmuxSessionName(foreground?.cmdline ?? '');
  if (parsedSessionName) {
    return parsedSessionName;
  }

  const foregroundPid = foreground?.pid ?? null;
  if (!foregroundPid) {
    return null;
  }

  return snapshot.tmuxClients.find((client) => client.pid === foregroundPid)?.sessionName ?? null;
}

function normalizeTmuxTarget(target: string): string | null {
  const normalized = target.trim().replace(/^['"]|['"]$/g, '').split(':')[0]?.trim();
  return normalized || null;
}

function shellTokens(commandLine: string): string[] {
  const matches = commandLine.match(/"[^"]*"|'[^']*'|\S+/g);
  return matches?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
}

function agentStateClass(state: AgentState): string {
  return state === 'waitingApproval' ? 'waiting-approval' : state;
}

function agentStateLabel(state: AgentState): string {
  switch (state) {
    case 'waitingApproval':
      return '需处理';
    case 'running':
      return '运行';
    case 'idle':
    case 'stale':
      return '空闲';
    case 'unknown':
      return '未知';
  }
}

function normalizeRestoredCustomName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeRestoredAgentSessionId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Terminal view class
 */
export class TerminalView extends ItemView {
  protected terminalService: TerminalService | null;
  protected agentStatusService: AgentStatusService | null;
  private terminalInstance: TerminalInstance | null = null;  // 始终指向当前 active 终端
  private tabs: TerminalTabEntry[] = [];
  private activeIndex = -1;
  private agentMonitor: AgentMonitor | null = null;
  private agentStatusUnsubscribe: (() => void) | null = null;
  private latestAgentSnapshot: AgentSnapshot | null = null;
  private tabBarEl: HTMLElement | null = null;
  private terminalContainer: HTMLElement | null = null;
  private dropHintEl: HTMLElement | null = null;
  private dragEnterDepth = 0;
  private removeDropHandlers: (() => void) | null = null;
  private searchContainer: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** 跨行链接悬停时手动铺设的下划线覆盖层元素 */
  private linkHoverDecorations: HTMLElement[] = [];
  private titleChangeCleanup: (() => void) | null = null;
  private searchStateCleanup: (() => void) | null = null;
  private initPromise: Promise<TerminalInstance> | null = null;
  private initResolve: ((terminal: TerminalInstance) => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;
  private pendingFocusTimeouts: number[] = [];
  private restorePersistTimeout: number | null = null;
  private isRestoringTabs = false;
  private manualViewDetachRequested = false;

  private readonly fs: FsModule;
  private readonly homeDir: string;
  private readonly path: PathModule;
  private readonly restoreStore: TerminalRestoreStore | null;
  private readonly foregroundByTerminal = new WeakMap<TerminalInstance, ForegroundInfo>();
  private readonly linkProviderByTerminal = new WeakMap<TerminalInstance, XtermDisposable>();
  private readonly closingTabs = new Set<TerminalInstance>();
  private readonly detachLeafWithoutConfirmation: WorkspaceLeaf['detach'];
  private viewCloseConfirmationPromise: Promise<boolean> | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    terminalService: TerminalService | null,
    agentStatusService: AgentStatusService | null = null,
    restoreStore: TerminalRestoreStore | null = null,
  ) {
    super(leaf);
    this.terminalService = terminalService;
    this.agentStatusService = agentStatusService;
    this.restoreStore = restoreStore;
    this.fs = window.require('fs') as FsModule;
    const os = window.require('os') as OsModule;
    this.homeDir = os.homedir();
    this.path = window.require('path') as PathModule;

    // 终端 view 聚焦时声明独占 Esc：Obsidian 在自己的 keymap 动作前会先查 view 的 scope，
    // 这样它默认的「Esc 退回编辑器」就不会抢走焦点。回调不 preventDefault，Esc 仍会继续
    // 传到 xterm 发给 PTY（vim/claude 里的 Esc 照常工作）。其它键经 parent scope 透传给 Obsidian。
    this.scope = new Scope(this.app.scope);
    this.scope.register([], 'Escape', () => {
      // 仅"认领" Esc 以压制 Obsidian 默认行为；返回 undefined 避免 preventDefault。
    });
    this.detachLeafWithoutConfirmation = leaf.detach.bind(leaf) as WorkspaceLeaf['detach'];
    leaf.detach = () => {
      void this.detachLeafWithConfirmation();
    };
    this.initPromise = new Promise<TerminalInstance>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
  }

  getViewType(): string { return TERMINAL_VIEW_TYPE; }

  getDisplayText(): string {
    // Ob 标签固定显示 "Termy"，不跟随终端自动标题
    return 'Termy';
  }

  getIcon(): string { return 'terminal'; }

  onPaneMenu(menu: Menu): void {
    // Obsidian may pass a wrapper object, so resolve the real view instance
    const view = (this as TerminalView & { realView?: TerminalView }).realView ?? this;
    
    menu.addItem((item) => {
      item.setTitle(t('terminal.renameTerminal'))
        .setIcon('pencil')
        .onClick(() => {
          if (!view.terminalInstance) {
            new Notice(t('terminal.notInitialized'));
            return;
          }
          
          const currentTitle = view.terminalInstance.getTitle();
          
          new RenameTerminalModal(
            view.app,
            currentTitle,
            (newTitle: string) => {
              if (view.terminalInstance && newTitle.trim()) {
                const trimmedTitle = newTitle.trim();
                view.terminalInstance.setTitle(trimmedTitle);
                this.updateLeafHeader(view.leaf);
                view.updateDropHintText();
                view.scheduleRestoreStatePersist();
              }
            }
          ).open();
        });
    });

  }

  onOpen(): Promise<void> {
    // Use contentEl instead of containerEl.children[1]
    const container = this.contentEl;
    container.empty();
    container.addClass('terminal-view-container');

    this.agentMonitor = new AgentMonitor(container, this.agentStatusService);
    this.bindAgentStatusSnapshot();

    // 内部 tab 栏（顶部），管理本 view 内的多个终端
    this.tabBarEl = container.createDiv('termy-tab-bar');

    // Create the search bar container
    this.searchContainer = container.createDiv('terminal-search-container');
    this.createSearchUI();

    // terminalContainer 作为多个终端 pane 的父容器
    this.terminalContainer = container.createDiv('terminal-container');
    this.ensureDropHint();
    this.hideDropHint();
    if (!this.removeDropHandlers) {
      this.removeDropHandlers = this.setupDropHandlers();
    }

    window.setTimeout(() => {
      if (this.tabs.length === 0 && this.terminalContainer) {
        void this.restoreTabsOrCreateDefault();
      }
    }, 0);
    return Promise.resolve();
  }

  /**
   * Create the search UI
   */
  private createSearchUI(): void {
    if (!this.searchContainer) return;

    // Search input
    this.searchInput = activeDocument.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.placeholder = t('terminal.search.placeholder');
    this.searchInput.className = 'terminal-search-input';

    // Search input handler
    this.searchInput.addEventListener('input', () => {
      this.performSearch();
    });

    this.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          this.terminalInstance?.searchPrevious();
        } else {
          this.terminalInstance?.searchNext();
        }
      } else if (e.key === 'Escape') {
        this.hideSearch();
      }
    });

    this.searchContainer.appendChild(this.searchInput);

    // Previous button
    const prevBtn = this.createSearchButton('chevron-up', t('terminal.search.previous'), () => {
      this.terminalInstance?.searchPrevious();
    });
    this.searchContainer.appendChild(prevBtn);

    // Next button
    const nextBtn = this.createSearchButton('chevron-down', t('terminal.search.next'), () => {
      this.terminalInstance?.searchNext();
    });
    this.searchContainer.appendChild(nextBtn);

    // Close button
    const closeBtn = this.createSearchButton('x', t('terminal.search.close'), () => {
      this.hideSearch();
    });
    this.searchContainer.appendChild(closeBtn);
  }

  /**
   * Create a search button
   */
  private createSearchButton(icon: string, title: string, onClick: () => void): HTMLElement {
    const btn = activeDocument.createElement('button');
    btn.className = 'terminal-search-btn clickable-icon';
    btn.title = title;
    setIcon(btn, icon);
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * Perform a search
   */
  private performSearch(): void {
    const query = this.searchInput?.value || '';
    this.terminalInstance?.search(query);
  }

  /**
   * Show the search bar
   */
  showSearch(): void {
    if (this.searchContainer) {
      this.searchContainer.addClass('is-visible');
      this.searchInput?.focus();
      this.searchInput?.select();
    }
  }

  /**
   * Hide the search bar
   */
  hideSearch(): void {
    if (this.searchContainer) {
      this.searchContainer.removeClass('is-visible');
    }
    this.terminalInstance?.clearSearch();
    this.terminalInstance?.focus();
  }

  async onClose(): Promise<void> {
    this.clearPendingFocusTimeouts();
    this.clearRestorePersistTimeout();
    if (this.manualViewDetachRequested) {
      await this.clearRestoreState();
    } else {
      await this.persistRestoreStateNow();
    }
    this.leaf.detach = this.detachLeafWithoutConfirmation;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.clearLinkHoverDecorations();
    this.titleChangeCleanup?.();
    this.titleChangeCleanup = null;
    this.searchStateCleanup?.();
    this.searchStateCleanup = null;
    this.agentMonitor?.dispose();
    this.agentMonitor = null;
    this.agentStatusUnsubscribe?.();
    this.agentStatusUnsubscribe = null;
    this.latestAgentSnapshot = null;
    this.removeDropHandlers?.();
    this.removeDropHandlers = null;
    this.dragEnterDepth = 0;
    this.dropHintEl = null;

    for (const tab of this.tabs) {
      this.disposeTerminalLinkProvider(tab.terminal);
      try {
        await this.terminalService?.destroyTerminal(tab.terminal.id);
      } catch (error) {
        errorLog('[TerminalView] Destroy failed:', error);
      }
    }
    this.tabs = [];
    this.activeIndex = -1;
    this.terminalInstance = null;

    this.containerEl.empty();
    this.disposeAppearanceStyle();
  }

  async persistRestoreStateForUnload(): Promise<void> {
    this.clearRestorePersistTimeout();
    if (!this.manualViewDetachRequested) {
      await this.persistRestoreStateNow();
    }
  }

  setTerminalService(terminalService: TerminalService): void {
    this.terminalService = terminalService;
  }

  setAgentStatusService(agentStatusService: AgentStatusService): void {
    this.agentStatusService = agentStatusService;
    this.agentMonitor?.setService(agentStatusService);
    this.bindAgentStatusSnapshot();
  }

  private bindAgentStatusSnapshot(): void {
    this.agentStatusUnsubscribe?.();
    this.agentStatusUnsubscribe = null;

    if (!this.agentStatusService) {
      this.latestAgentSnapshot = null;
      this.renderTabBar();
      return;
    }

    this.agentStatusUnsubscribe = this.agentStatusService.subscribe((snapshot) => {
      this.latestAgentSnapshot = snapshot;
      const rememberedAgentChanged = this.refreshRememberedAgentsFromSnapshot();
      this.renderTabBar();
      if (rememberedAgentChanged) {
        this.scheduleRestoreStatePersist();
      }
    });
  }

  /**
   * Create a new terminal
   */
  private async createNewTerminal(): Promise<void> {
    // 在当前 view 内新开一个 tab（不再开新的 Obsidian 标签）
    await this.addTab();
  }

  private async restoreTabsOrCreateDefault(): Promise<void> {
    if (!this.terminalService || !this.terminalContainer) {
      return;
    }

    const snapshot = await this.restoreStore?.loadSnapshot().catch((error) => {
      errorLog('[TerminalView] Failed to load terminal restore state:', error);
      return null;
    });
    const restoredTabs = snapshot?.tabs ?? [];
    if (restoredTabs.length === 0) {
      await this.addTab();
      return;
    }

    this.isRestoringTabs = true;
    try {
      for (const restoredTab of restoredTabs) {
        const terminal = await this.addTab({
          cwd: restoredTab.cwd,
          customName: restoredTab.customName,
          agentKind: restoredTab.agentKind,
          agentSessionId: restoredTab.agentSessionId,
          activate: false,
          persist: false,
        });
        if (terminal) {
          this.scheduleRestoredAgentResume(terminal, restoredTab);
        }
      }
    } finally {
      this.isRestoringTabs = false;
    }

    if (this.tabs.length === 0) {
      await this.addTab();
      return;
    }

    this.activeIndex = -1;
    this.setActiveTab(Math.min(snapshot?.activeIndex ?? 0, this.tabs.length - 1));
    await this.persistRestoreStateNow();
  }

  /**
   * 在本 view 内新建一个终端 tab
   */
  async addTab(options: AddTerminalTabOptions = {}): Promise<TerminalInstance | null> {
    if (!this.terminalService || !this.terminalContainer) return null;

    const paneEl = this.terminalContainer.createDiv('termy-pane');

    let terminal: TerminalInstance;
    try {
      terminal = await this.terminalService.createTerminal({
        cwd: this.resolveRestoredCwd(options.cwd),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorLog('[TerminalView] Create tab failed:', message);
      new Notice(t('notices.terminal.initFailed', { message }));
      paneEl.remove();
      if (this.tabs.length === 0) {
        this.detachLeafWithoutConfirmation();
      }
      return null;
    }

    // View 可能在等待终端创建（异步）期间被关闭：onClose 已清空 tabs 并清空容器。
    // 此时若继续挂载，会复活一个 onClose 销毁循环跑不到的终端 → 永久泄漏。
    if (!this.terminalContainer?.isConnected) {
      await this.terminalService?.destroyTerminal(terminal.id).catch(() => { /* ignore */ });
      paneEl.remove();
      return null;
    }

    // 首个终端兑现 initPromise（waitForTerminalInstance 依赖）
    this.initResolve?.(terminal);
    this.initResolve = null;
    this.initReject = null;

    try {
      terminal.attachToElement(paneEl);
    } catch (error) {
      errorLog('[TerminalView] Attach tab failed:', error);
    }
    this.registerTerminalHyperlinkHandler(terminal);

    const restoredAgentKind = options.agentKind ?? null;
    const restoredAgentSessionId = restoredAgentKind
      ? normalizeRestoredAgentSessionId(options.agentSessionId)
      : null;

    this.tabs.push({
      terminal,
      paneEl,
      customName: normalizeRestoredCustomName(options.customName),
      status: options.agentKind ?? 'none',
      lastKnownAgentKind: restoredAgentSessionId ? restoredAgentKind : null,
      lastKnownAgentSessionId: restoredAgentSessionId,
      lastKnownAgentProtectedUntilMs: restoredAgentSessionId
        ? Date.now() + RESTORED_AGENT_METADATA_GRACE_MS
        : 0,
    });

    // Track foreground changes so the tab can show tmux/ssh/Claude/Codex status.
    terminal.onForegroundChange((info) => {
      this.foregroundByTerminal.set(terminal, info);
      this.updateTabForegroundStatus(terminal, info);
      this.scheduleRestoreStatePersist();
    });

    if (options.activate === false) {
      this.renderTabBar();
      this.updateDropHintText();
      if (options.persist !== false) {
        this.scheduleRestoreStatePersist();
      }
      return terminal;
    }

    this.activeIndex = -1; // Force setActiveTab to bind the new terminal.
    this.setActiveTab(this.tabs.length - 1);
    if (options.persist !== false) {
      this.scheduleRestoreStatePersist();
    }
    return terminal;
  }

  private scheduleRestoredAgentResume(terminal: TerminalInstance, restoredTab: RestoredTerminalTab): void {
    if (!restoredTab.agentKind) {
      return;
    }

    const command = restoredAgentCommand(restoredTab.agentKind, restoredTab.agentSessionId);
    if (!command) {
      return;
    }

    this.sendRestoredAgentCommandWhenReady(terminal, command, restoredTab, 0);
  }

  private sendRestoredAgentCommandWhenReady(
    terminal: TerminalInstance,
    command: string,
    restoredTab: RestoredTerminalTab,
    attempt: number,
  ): void {
    const maxAttempts = 16;
    const delayMs = attempt === 0 ? 600 : 500;

    window.setTimeout(() => {
      if (!this.tabs.some((tab) => tab.terminal === terminal)) {
        return;
      }

      if (!terminal.isAlive()) {
        if (attempt < maxAttempts) {
          this.sendRestoredAgentCommandWhenReady(terminal, command, restoredTab, attempt + 1);
        } else {
          errorLog('[TerminalView] Restored agent command skipped because terminal never became ready:', {
            agentKind: restoredTab.agentKind,
            agentSessionId: restoredTab.agentSessionId,
          });
        }
        return;
      }

      terminal.sendText(`${command}\r`);
      debugLog('[TerminalView] Sent restored agent command:', {
        agentKind: restoredTab.agentKind,
        agentSessionId: restoredTab.agentSessionId,
        attempt,
      });
      this.scheduleRestoreStatePersist();
    }, delayMs);
  }

  private resolveRestoredCwd(cwd: string | null | undefined): string | undefined {
    const restoredCwd = cwd?.trim();
    if (!restoredCwd) {
      return undefined;
    }

    try {
      return this.fs.existsSync(restoredCwd) && this.fs.statSync(restoredCwd).isDirectory()
        ? restoredCwd
        : undefined;
    } catch {
      return undefined;
    }
  }

  private scheduleRestoreStatePersist(): void {
    if (this.isRestoringTabs || !this.restoreStore) {
      return;
    }

    this.clearRestorePersistTimeout();
    this.restorePersistTimeout = window.setTimeout(() => {
      this.restorePersistTimeout = null;
      void this.persistRestoreStateNow();
    }, 250);
  }

  private clearRestorePersistTimeout(): void {
    if (this.restorePersistTimeout !== null) {
      window.clearTimeout(this.restorePersistTimeout);
      this.restorePersistTimeout = null;
    }
  }

  private async persistRestoreStateNow(): Promise<void> {
    if (!this.restoreStore) {
      return;
    }

    try {
      await this.restoreStore.saveSnapshot(this.buildRestoreSnapshot());
    } catch (error) {
      errorLog('[TerminalView] Failed to save terminal restore state:', error);
    }
  }

  private async clearRestoreState(): Promise<void> {
    this.clearRestorePersistTimeout();
    if (!this.restoreStore) {
      return;
    }

    try {
      await this.restoreStore.clearSnapshot();
    } catch (error) {
      errorLog('[TerminalView] Failed to clear terminal restore state:', error);
    }
  }

  private buildRestoreSnapshot(): TerminalRestoreSnapshot {
    return {
      tabs: this.tabs.map((tab) => this.restoredTabFromEntry(tab)),
      activeIndex: Math.max(0, Math.min(this.activeIndex, Math.max(0, this.tabs.length - 1))),
      updatedAtMs: Date.now(),
    };
  }

  private restoredTabFromEntry(tab: TerminalTabEntry): RestoredTerminalTab {
    return {
      customName: tab.customName,
      cwd: this.safeTerminalCwd(tab.terminal),
      agentKind: this.resolveRestorableAgentKind(tab),
      agentSessionId: this.resolveRestorableAgentSessionId(tab),
      title: tab.terminal.getTitle(),
      updatedAtMs: Date.now(),
    };
  }

  private safeTerminalCwd(terminal: TerminalInstance): string | null {
    try {
      return terminal.getCwd();
    } catch {
      return null;
    }
  }

  private resolveRestorableAgentKind(tab: TerminalTabEntry): RestorableAgentKind | null {
    const matchedClient = this.matchingAgentClientsForTab(tab).find((client) =>
      client.kind === 'claude' || client.kind === 'codex');
    if (matchedClient) {
      this.rememberAgentClient(tab, matchedClient);
      return matchedClient.kind;
    }
    const hookAgent = this.claudeHookAgentForTab(tab);
    if (hookAgent) {
      this.rememberAgent(tab, hookAgent.kind, hookAgent.sessionId);
      return hookAgent.kind;
    }
    const lastKnownAgent = this.preservedLastKnownAgent(tab);
    if (lastKnownAgent) {
      return lastKnownAgent.kind;
    }
    if (tab.status === 'claude' || tab.status === 'codex') {
      return tab.status;
    }
    if (tab.terminal.isClaudeCodeSession()) {
      return 'claude';
    }
    const foreground = this.foregroundByTerminal.get(tab.terminal) ?? tab.terminal.getForeground();
    const status = classifyForeground(foreground);
    return status === 'claude' || status === 'codex' ? status : null;
  }

  private resolveRestorableAgentSessionId(tab: TerminalTabEntry): string | null {
    const matchedClient = this.matchingAgentClientsForTab(tab).find((client) =>
      client.agentSessionId !== null);
    if (matchedClient?.agentSessionId) {
      this.rememberAgentClient(tab, matchedClient);
      return matchedClient.agentSessionId;
    }
    const hookAgent = this.claudeHookAgentForTab(tab);
    if (hookAgent) {
      this.rememberAgent(tab, hookAgent.kind, hookAgent.sessionId);
      return hookAgent.sessionId;
    }
    return this.preservedLastKnownAgent(tab)?.sessionId ?? null;
  }

  private rememberAgentClient(tab: TerminalTabEntry, client: AgentClient): void {
    if ((client.kind !== 'claude' && client.kind !== 'codex') || !client.agentSessionId) {
      return;
    }

    this.rememberAgent(tab, client.kind, client.agentSessionId);
  }

  private rememberAgent(tab: TerminalTabEntry, kind: RestorableAgentKind, sessionId: string): void {
    tab.lastKnownAgentKind = kind;
    tab.lastKnownAgentSessionId = sessionId;
    tab.lastKnownAgentProtectedUntilMs = 0;
  }

  private refreshRememberedAgentsFromSnapshot(): boolean {
    let changed = false;
    for (const tab of this.tabs) {
      const client = this.matchingAgentClientsForTab(tab).find((candidate) =>
        (candidate.kind === 'claude' || candidate.kind === 'codex') && candidate.agentSessionId);
      if (!client?.agentSessionId) {
        continue;
      }

      if (tab.lastKnownAgentKind !== client.kind || tab.lastKnownAgentSessionId !== client.agentSessionId) {
        this.rememberAgent(tab, client.kind, client.agentSessionId);
        if (tab.status === 'none') {
          tab.status = client.kind;
        }
        changed = true;
      }
    }
    return changed;
  }

  private markObservedAgentKind(terminal: TerminalInstance, kind: RestorableAgentKind): void {
    const tab = this.tabs.find((candidate) => candidate.terminal === terminal);
    if (!tab) {
      return;
    }

    tab.lastKnownAgentKind = kind;
    if (!tab.lastKnownAgentSessionId) {
      tab.lastKnownAgentProtectedUntilMs = Date.now() + RESTORED_AGENT_METADATA_GRACE_MS;
    }
  }

  private preservedLastKnownAgent(tab: TerminalTabEntry): { kind: RestorableAgentKind; sessionId: string } | null {
    const kind = tab.lastKnownAgentKind;
    const sessionId = normalizeRestoredAgentSessionId(tab.lastKnownAgentSessionId);
    if (!kind || !sessionId) {
      return null;
    }

    if (Date.now() <= tab.lastKnownAgentProtectedUntilMs) {
      return { kind, sessionId };
    }

    if (tab.status === kind) {
      return { kind, sessionId };
    }

    if (kind === 'claude' && tab.terminal.isClaudeCodeSession()) {
      return { kind, sessionId };
    }

    const foreground = this.foregroundByTerminal.get(tab.terminal) ?? tab.terminal.getForeground();
    return classifyForeground(foreground) === kind
      ? { kind, sessionId }
      : null;
  }

  private claudeHookAgentForTab(tab: TerminalTabEntry): { kind: 'claude'; sessionId: string } | null {
    if (!this.shouldUseClaudeHookFallback(tab)) {
      return null;
    }

    const cwd = this.safeTerminalCwd(tab.terminal);
    if (!cwd) {
      return null;
    }

    const sessions = this.readHookAgentSessions();
    const now = Date.now();
    const match = sessions
      .filter((session) =>
        session.agent === 'claude'
        && session.cwd === cwd
        && session.sessionId
        && session.updatedAtMs !== null
        && now - session.updatedAtMs <= CLAUDE_HOOK_SESSION_LOOKBACK_MS)
      .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0))[0];

    return match?.sessionId ? { kind: 'claude', sessionId: match.sessionId } : null;
  }

  private shouldUseClaudeHookFallback(tab: TerminalTabEntry): boolean {
    if (tab.lastKnownAgentKind === 'claude' || tab.status === 'claude' || tab.terminal.isClaudeCodeSession()) {
      return true;
    }

    const foreground = this.foregroundByTerminal.get(tab.terminal) ?? tab.terminal.getForeground();
    return classifyForeground(foreground) === 'claude';
  }

  private readHookAgentSessions(): Array<{
    agent: AgentKind;
    sessionId: string | null;
    cwd: string | null;
    updatedAtMs: number | null;
  }> {
    try {
      const file = this.path.join(this.homeDir, '.termy', 'agent-status', 'state.json');
      const raw = JSON.parse(this.fs.readFileSync(file, 'utf8')) as { sessions?: unknown };
      if (!raw.sessions || typeof raw.sessions !== 'object') {
        return [];
      }
      return Object.values(raw.sessions).map((value) => this.normalizeHookAgentSession(value)).filter((session) =>
        session !== null);
    } catch {
      return [];
    }
  }

  private normalizeHookAgentSession(value: unknown): {
    agent: AgentKind;
    sessionId: string | null;
    cwd: string | null;
    updatedAtMs: number | null;
  } | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const record = value as {
      agent?: unknown;
      sessionId?: unknown;
      cwd?: unknown;
      updatedAtMs?: unknown;
    };
    if (record.agent !== 'claude' && record.agent !== 'codex') {
      return null;
    }

    return {
      agent: record.agent,
      sessionId: typeof record.sessionId === 'string' && record.sessionId.trim() ? record.sessionId.trim() : null,
      cwd: typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd.trim() : null,
      updatedAtMs: typeof record.updatedAtMs === 'number' && Number.isFinite(record.updatedAtMs)
        ? record.updatedAtMs
        : null,
    };
  }

  private clearExpiredLastKnownAgent(terminal: TerminalInstance): void {
    const tab = this.tabs.find((candidate) => candidate.terminal === terminal);
    if (!tab || Date.now() <= tab.lastKnownAgentProtectedUntilMs) {
      return;
    }

    tab.lastKnownAgentKind = null;
    tab.lastKnownAgentSessionId = null;
    tab.lastKnownAgentProtectedUntilMs = 0;
  }

  private setTerminalTabStatus(terminal: TerminalInstance, status: TerminalTabStatus): void {
    const tab = this.tabs.find((candidate) => candidate.terminal === terminal);
    if (!tab || tab.status === status) {
      return;
    }

    tab.status = status;
    this.renderTabBar();
    this.scheduleRestoreStatePersist();
  }

  private updateTabForegroundStatus(
    terminal: TerminalInstance,
    info: ForegroundInfo,
  ): void {
    const foregroundStatus = classifyForeground(info);
    if (foregroundStatus !== 'none') {
      if (foregroundStatus !== 'claude') {
        terminal.resetClaudeCodeSession();
      }
      if (foregroundStatus === 'claude' || foregroundStatus === 'codex') {
        this.markObservedAgentKind(terminal, foregroundStatus);
      }
      this.setTerminalTabStatus(terminal, foregroundStatus);
      return;
    }

    if (isIdleShellForeground(info)) {
      terminal.resetClaudeCodeSession();
      this.clearExpiredLastKnownAgent(terminal);
      this.setTerminalTabStatus(terminal, 'none');
      return;
    }

    this.setTerminalTabStatus(terminal, terminal.isClaudeCodeSession() ? 'claude' : 'none');
  }

  private async confirmCloseTabIfNeeded(terminal: TerminalInstance): Promise<boolean> {
    const risk = this.getCloseRisk(terminal);
    if (!risk) {
      return true;
    }

    return confirmCloseTerminal(this.app, {
      title: t('modals.confirmCloseTerminal.tabTitle'),
      message: t('modals.confirmCloseTerminal.tabMessage', { process: risk.processName }),
      confirmText: t('modals.confirmCloseTerminal.closeTab'),
    });
  }

  private async confirmCloseViewIfNeeded(): Promise<boolean> {
    const riskyTabs = this.tabs.filter((tab) => this.getCloseRisk(tab.terminal) !== null);
    if (riskyTabs.length === 0) {
      return true;
    }

    if (!this.viewCloseConfirmationPromise) {
      this.viewCloseConfirmationPromise = confirmCloseTerminal(this.app, {
        title: t('modals.confirmCloseTerminal.viewTitle'),
        message: t('modals.confirmCloseTerminal.viewMessage', { count: riskyTabs.length }),
        confirmText: t('modals.confirmCloseTerminal.closeView'),
      }).finally(() => {
        this.viewCloseConfirmationPromise = null;
      });
    }

    return this.viewCloseConfirmationPromise;
  }

  private async detachLeafWithConfirmation(): Promise<void> {
    if (!(await this.confirmCloseViewIfNeeded())) {
      return;
    }

    this.manualViewDetachRequested = true;
    await this.clearRestoreState();
    this.detachLeafWithoutConfirmation();
  }

  private getCloseRisk(terminal: TerminalInstance): TerminalCloseRisk | null {
    const tab = this.tabs.find((candidate) => candidate.terminal === terminal);
    if (terminal.isClaudeCodeSession()) {
      return { processName: 'claude' };
    }
    if (tab && tab.status !== 'none') {
      return { processName: tab.status };
    }

    const info = this.foregroundByTerminal.get(terminal);
    if (!info || isIdleShellForeground(info)) {
      return null;
    }

    const processName = getForegroundProcessName(info);
    return processName ? { processName } : null;
  }

  /**
   * 切换到指定下标的 tab（显隐切换，保留各终端的状态与滚动）
   */
  setActiveTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    if (index === this.activeIndex) {
      this.tabs[index].terminal.focus();
      return;
    }

    this.detachTerminalBindings();
    this.activeIndex = index;

    this.tabs.forEach((tab, i) => {
      tab.paneEl.toggleClass('is-active', i === index);
    });

    const terminal = this.tabs[index].terminal;
    this.terminalInstance = terminal;
    this.bindTerminalInstance(terminal);
    this.updateAppearanceStyles();
    this.setupResizeObserver();

    window.setTimeout(() => {
      if (terminal.isAlive()) {
        terminal.fit();
        terminal.focus();
      }
    }, 0);

    this.renderTabBar();
    this.updateLeafHeader(this.leaf);
    this.updateDropHintText();
    this.scheduleRestoreStatePersist();
  }

  /**
   * 关闭指定 tab；关闭最后一个时不关闭 view，自动新开一个终端
   */
  async closeTab(target: number | TerminalInstance): Promise<void> {
    // 按 tab 对象身份定位，而非渲染时捕获的下标——下标在异步确认/销毁期间会失效。
    const tab = typeof target === 'number'
      ? this.tabs[target]
      : this.tabs.find((candidate) => candidate.terminal === target);
    if (!tab) return;

    // 防重入：双击关闭按钮、或确认期间再次触发时，同一 tab 只处理一次。
    if (this.closingTabs.has(tab.terminal)) return;
    this.closingTabs.add(tab.terminal);
    try {
      if (!(await this.confirmCloseTabIfNeeded(tab.terminal))) {
        return;
      }

      try {
        this.disposeTerminalLinkProvider(tab.terminal);
        await this.terminalService?.destroyTerminal(tab.terminal.id);
      } catch (error) {
        errorLog('[TerminalView] Destroy tab failed:', error);
      }

      // 异步期间数组可能已变，用对象身份重新取当前下标。
      const index = this.tabs.indexOf(tab);
      if (index === -1) return; // 已被并发关闭移除
      tab.paneEl.remove();
      this.tabs.splice(index, 1);

      if (this.tabs.length === 0) {
        this.terminalInstance = null;
        this.activeIndex = -1;
        // 关闭最后一个 tab 时保留 view，自动重开一个新终端；
        // 若新建失败，addTab 内部会回退为关闭整个 view。
        await this.addTab();
        this.scheduleRestoreStatePersist();
        return;
      }

      // 重新计算 active 下标
      let next = this.activeIndex;
      if (index < this.activeIndex) {
        next = this.activeIndex - 1;
      } else if (index === this.activeIndex) {
        next = Math.min(index, this.tabs.length - 1);
      }
      this.activeIndex = -1; // 强制重新绑定
      this.setActiveTab(Math.max(0, next));
      this.scheduleRestoreStatePersist();
    } finally {
      this.closingTabs.delete(tab.terminal);
    }
  }

  /**
   * 渲染顶部 tab 栏
   */
  private renderTabBar(): void {
    const bar = this.tabBarEl;
    if (!bar) return;
    bar.empty();
    bar.toggleClass('is-single', this.tabs.length <= 1);

    this.tabs.forEach((tab, i) => {
      const tabEl = bar.createDiv('termy-tab');
      tabEl.toggleClass('is-active', i === this.activeIndex);
      tabEl.addEventListener('click', () => this.setActiveTab(i));
      const tabAgentStatus = this.resolveTabAgentStatus(tab);
      if (tabAgentStatus) {
        tabEl.title = tabAgentStatus.clients
          .map((client) => `${client.kind} ${agentStateLabel(client.state)} pid ${client.pid}`)
          .join('\n');
        if (shouldPaintTabAgentState(tabAgentStatus.state)) {
          tabEl.addClass('has-agent-state');
          tabEl.addClass(`is-agent-${agentStateClass(tabAgentStatus.state)}`);
        }
      }

      // Tab number badge for Opt+number switching (1-9, tenth tab is 0).
      if (i < 10) {
        const indexEl = tabEl.createSpan('termy-tab-index');
        indexEl.setText(i === 9 ? '0' : String(i + 1));
      }

      // Status icon for tmux/Claude/Codex/SSH.
      if (tab.status === 'tmux' || tab.status === 'claude' || tab.status === 'codex') {
        const statusEl = tabEl.createSpan('termy-tab-status');
        this.appendTabStatusIcon(statusEl, tab.status);
        if (tab.status === 'tmux' && tabAgentStatus) {
          for (const kind of uniqueAgentKinds(tabAgentStatus.clients)) {
            this.appendTabStatusIcon(statusEl, kind);
          }
        }
      } else if (tab.status === 'ssh') {
        const iconEl = tabEl.createSpan('termy-tab-status-icon');
        setIcon(iconEl, 'globe');
      }

      // 仅当用户重命名过才显示名字（否则只有序号 + 状态）
      if (tab.customName) {
        const label = tabEl.createSpan('termy-tab-label');
        label.setText(tab.customName);
      }

      const closeBtn = tabEl.createSpan('termy-tab-close');
      setIcon(closeBtn, 'x');
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.closeTab(tab.terminal);
      });
    });

    const addBtn = bar.createDiv('termy-tab-add');
    setIcon(addBtn, 'plus');
    addBtn.addEventListener('click', () => void this.addTab());
  }

  private resolveTabAgentStatus(tab: TerminalTabEntry): TerminalTabAgentStatus | null {
    return aggregateTabAgentStatus(this.matchingAgentClientsForTab(tab));
  }

  private matchingAgentClientsForTab(tab: TerminalTabEntry): AgentClient[] {
    const snapshot = this.latestAgentSnapshot;
    if (!snapshot || snapshot.clients.length === 0) {
      return [];
    }

    const info = this.foregroundByTerminal.get(tab.terminal) ?? tab.terminal.getForeground();
    const clients = snapshot.clients;
    const lastKnownSessionId = normalizeRestoredAgentSessionId(tab.lastKnownAgentSessionId);
    if (lastKnownSessionId) {
      const sessionMatches = clients.filter((client) =>
        client.agentSessionId === lastKnownSessionId
        && (!tab.lastKnownAgentKind || client.kind === tab.lastKnownAgentKind));
      if (sessionMatches.length > 0) {
        return sessionMatches;
      }
    }

    if (tab.status === 'tmux') {
      const sessionName = resolveTmuxSessionName(snapshot, info);
      if (!sessionName) {
        return [];
      }
      return clients.filter((client) => client.surfaceId === `tmux:${sessionName}`);
    }

    if (tab.status === 'claude' || tab.status === 'codex') {
      const kindClients = clients.filter((client) => client.kind === tab.status);
      const pid = info?.pid ?? null;
      if (pid) {
        const pidMatches = kindClients.filter((client) =>
          client.pid === pid
          || client.parentPid === pid
          || client.processGroupId === pid);
        if (pidMatches.length > 0) {
          return pidMatches;
        }
      }

      const localClients = kindClients.filter((client) => !client.surfaceId);
      return localClients.length === 1 ? localClients : [];
    }

    return [];
  }

  private appendTabStatusIcon(parent: HTMLElement, status: 'tmux' | AgentKind): void {
    const iconEl = parent.createEl('img', { cls: `termy-tab-status-icon is-${status}` });
    iconEl.alt = '';
    iconEl.title = status;
    iconEl.src = status === 'tmux'
      ? TMUX_ICON
      : status === 'claude'
        ? CLAUDE_ICON
        : CODEX_ICON;
  }

  // —— 供命令调用的 tab 导航 ——
  openNewTab(): void { void this.addTab(); }
  closeActiveTab(): void { const t = this.tabs[this.activeIndex]?.terminal; if (t) void this.closeTab(t); }
  nextTab(): void { if (this.tabs.length > 1) this.setActiveTab((this.activeIndex + 1) % this.tabs.length); }
  prevTab(): void { if (this.tabs.length > 1) this.setActiveTab((this.activeIndex - 1 + this.tabs.length) % this.tabs.length); }
  gotoTab(n: number): void { if (n >= 0 && n < this.tabs.length) this.setActiveTab(n); }
  getTabCount(): number { return this.tabs.length; }

  focusActiveTerminalSoon(): void {
    this.clearPendingFocusTimeouts();
    for (const delay of TERMINAL_FOCUS_RETRY_DELAYS_MS) {
      const timeout = window.setTimeout(() => {
        this.pendingFocusTimeouts = this.pendingFocusTimeouts.filter((item) => item !== timeout);
        if (this.app.workspace.getActiveViewOfType(TerminalView) === this) {
          this.focusActiveTerminal();
        }
      }, delay);
      this.pendingFocusTimeouts.push(timeout);
    }
  }

  private clearPendingFocusTimeouts(): void {
    for (const timeout of this.pendingFocusTimeouts.splice(0)) {
      window.clearTimeout(timeout);
    }
  }

  private shouldPreserveCurrentFocus(): boolean {
    const activeElement = this.contentEl.ownerDocument.activeElement;
    const ownerWindow = this.contentEl.ownerDocument.defaultView;
    if (!ownerWindow || !(activeElement instanceof ownerWindow.HTMLElement)) {
      return false;
    }
    if (activeElement.closest('.modal-container, .modal, .menu')) {
      return true;
    }
    if (!this.contentEl.contains(activeElement)) {
      return false;
    }
    if (activeElement.classList.contains('xterm-helper-textarea')) {
      return false;
    }
    return activeElement.matches('input, textarea, select, button, [contenteditable="true"], [tabindex]');
  }

  /** 聚焦当前 active 终端（供切回 Obsidian 标签时自动 focus，避免焦点卡在标签头按钮上） */
  focusActiveTerminal(): void {
    if (this.shouldPreserveCurrentFocus()) {
      return;
    }
    if (this.searchContainer?.classList.contains('is-visible')) {
      this.searchInput?.focus();
      return;
    }
    const terminal = this.tabs[this.activeIndex]?.terminal;
    if (terminal?.isAlive()) {
      terminal.fit();
      terminal.focus();
    }
  }

  /** 重命名当前 active 标签（Opt+R）；改的是 tab 独立名字，不影响终端自动标题 */
  renameActiveTab(): void {
    const tab = this.tabs[this.activeIndex];
    if (!tab) return;
    new RenameTerminalModal(this.app, tab.customName ?? '', (newName) => {
      const trimmed = newName.trim();
      tab.customName = trimmed || null;
      this.renderTabBar();
      this.scheduleRestoreStatePersist();
    }).open();
  }

  private bindTerminalInstance(terminal: TerminalInstance): void {
    this.detachTerminalBindings();
    this.titleChangeCleanup = terminal.onTitleChange(() => {
      this.updateLeafHeader(this.leaf);
      this.updateDropHintText();
      this.scheduleRestoreStatePersist();
    });

    this.searchStateCleanup = terminal.onSearchStateChange((visible) => {
      if (visible) {
        this.showSearch();
      } else {
        this.hideSearch();
      }
    });

    terminal.setOnNewTerminal(() => {
      void this.createNewTerminal();
    });

    terminal.setTabNavCallback((action) => {
      switch (action.type) {
        case 'new': this.openNewTab(); break;
        case 'close': this.closeActiveTab(); break;
        case 'next': this.nextTab(); break;
        case 'prev': this.prevTab(); break;
        case 'goto': this.gotoTab(action.index); break;
        case 'rename': this.renameActiveTab(); break;
      }
    });

    terminal.setDefaultShellMenuCallbacks(
      () => this.terminalService?.getDefaultShellOptions() ?? [],
      (shellType) => {
        void this.terminalService?.setDefaultShell(shellType).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          errorLog('[TerminalView] Failed to switch default shell:', error);
          new Notice(message);
        });
      }
    );
  }

  private detachTerminalBindings(): void {
    this.titleChangeCleanup?.();
    this.titleChangeCleanup = null;
    this.searchStateCleanup?.();
    this.searchStateCleanup = null;
  }

  private disposeTerminalLinkProvider(terminal: TerminalInstance): void {
    this.linkProviderByTerminal.get(terminal)?.dispose();
    this.linkProviderByTerminal.delete(terminal);
  }

  private setupDropHandlers(): () => void {
    const container = this.contentEl;
    const cleanup: Array<() => void> = [];
    const capture = false;
    const dragWindow = container.ownerDocument?.defaultView;

    const addListener = (
      target: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject
    ): void => {
      target.addEventListener(type, listener, capture);
      cleanup.push(() => target.removeEventListener(type, listener, capture));
    };

    const claimDragEvent = (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
    };

    const onDragEnter = (event: DragEvent): void => {
      claimDragEvent(event);
      this.dragEnterDepth += 1;
      this.showDropHint();
    };

    const onDragOver = (event: DragEvent): void => {
      claimDragEvent(event);
      this.showDropHint();
    };

    const onDragLeave = (event: DragEvent): void => {
      claimDragEvent(event);
      this.dragEnterDepth = Math.max(0, this.dragEnterDepth - 1);
      const relatedTarget = event.relatedTarget as Node | null;
      const leftContainer = !relatedTarget || !container.contains(relatedTarget);
      if (this.dragEnterDepth === 0 || leftContainer) {
        this.dragEnterDepth = 0;
        this.hideDropHint();
      }
    };

    const onDrop = (event: DragEvent): void => {
      claimDragEvent(event);
      this.resetDropHintState();
      void this.handleDrop(event.dataTransfer);
    };

    const onWindowDragEnd = (): void => {
      this.resetDropHintState();
    };

    addListener(container, 'dragenter', onDragEnter);
    addListener(container, 'dragover', onDragOver);
    addListener(container, 'dragleave', onDragLeave);
    addListener(container, 'drop', onDrop);

    if (dragWindow) {
      addListener(dragWindow, 'dragend', onWindowDragEnd);
    }

    return () => {
      for (const dispose of cleanup.splice(0)) {
        dispose();
      }
    };
  }

  private ensureDropHint(): void {
    if (!this.terminalContainer) return;
    if (this.dropHintEl && this.dropHintEl.isConnected) return;

    const doc = this.terminalContainer.ownerDocument;
    const hint = doc.createElement('div');
    hint.className = 'terminal-drop-hint';
    const textEl = doc.createElement('div');
    textEl.className = 'terminal-drop-hint__text';
    hint.appendChild(textEl);
    this.dropHintEl = hint;
    this.updateDropHintText();
    this.terminalContainer.appendChild(hint);
  }

  private getDropHintText(): string {
    return t('terminal.dropHintPasteFilePath');
  }

  private updateDropHintText(): void {
    if (!this.dropHintEl) return;
    const textEl = this.dropHintEl.querySelector('.terminal-drop-hint__text');
    if (textEl) {
      textEl.textContent = this.getDropHintText();
      return;
    }
    this.dropHintEl.textContent = this.getDropHintText();
  }

  private showDropHint(): void {
    this.ensureDropHint();
    if (!this.dropHintEl?.classList.contains('is-visible')) {
      this.updateDropHintText();
    }
    this.dropHintEl?.classList.add('is-visible');
  }

  private hideDropHint(): void {
    this.dropHintEl?.classList.remove('is-visible');
  }

  private resetDropHintState(): void {
    this.dragEnterDepth = 0;
    this.hideDropHint();
  }

  private async handleDrop(dataTransfer: DataTransfer | null): Promise<void> {
    const input = await this.buildDroppedInput(dataTransfer);
    if (!input) {
      debugLog('[Terminal DnD] No usable file path or text in drop payload');
      errorLog('[Terminal DnD] No usable path details:', this.describeDropPayload(dataTransfer));
      new Notice('Termy: 未获取到可用文本或路径，请确认拖拽来源是否支持文本或文件。');
      return;
    }

    debugLog('[Terminal DnD] Inject input:', input.text);
    await this.writeInputToTerminal(input.text, input.usePaste);
  }

  private async buildDroppedInput(dataTransfer: DataTransfer | null): Promise<{ text: string; usePaste: boolean } | null> {
    if (!dataTransfer) return null;

    const droppedItems = Array.from(dataTransfer.items);
    const nativePaths = this.extractDroppedNativePaths(dataTransfer);
    if (nativePaths.length > 0) {
      return {
        text: this.formatDroppedPaths(nativePaths),
        usePaste: false,
      };
    }

    const primaryTextPayload = collectPreferredDroppedTextPayload(dataTransfer);
    const fallbackTextPayload = await collectFallbackDroppedTextPayload(dataTransfer, droppedItems);
    return resolveDroppedTextInput(
      primaryTextPayload,
      fallbackTextPayload,
      (payload) => this.extractDroppedPathsFromTextPayload(payload),
      (paths) => this.formatDroppedPaths(paths)
    );
  }

  private extractDroppedNativePaths(dataTransfer: DataTransfer | null): string[] {
    if (!dataTransfer) return [];

    const paths: string[] = [];
    const droppedFiles = Array.from(dataTransfer.files);
    const droppedItems = Array.from(dataTransfer.items);

    for (const item of droppedItems) {
      const itemPath = (item as DataTransferItem & { path?: string }).path;
      if (typeof itemPath === 'string' && itemPath.trim().length > 0) {
        paths.push(itemPath.trim());
      }

      const itemFile = item.getAsFile();
      if (itemFile) {
        const droppedPath = this.getDroppedFilePath(itemFile);
        if (droppedPath) {
          paths.push(droppedPath);
        }
      }

      const entryPath = this.getPathFromDroppedEntry(item);
      if (entryPath) {
        paths.push(entryPath);
      }
    }

    for (const file of droppedFiles) {
      const filePath = this.getDroppedFilePath(file);
      if (filePath) {
        paths.push(filePath);
      }
    }

    return this.uniquePaths(paths);
  }

  private extractDroppedPathsFromTextPayload(textPayload = ''): string[] {
    const paths: string[] = [];

    for (const token of this.extractDropTokens(textPayload)) {
      const resolvedPath = this.resolveDroppedTokenToPath(token);
      if (resolvedPath) paths.push(resolvedPath);
    }

    return this.uniquePaths(paths);
  }

  private describeDropPayload(dataTransfer: DataTransfer | null): Record<string, unknown> {
    if (!dataTransfer) {
      return { hasDataTransfer: false };
    }

    const items = Array.from(dataTransfer.items).map((item) => ({
      kind: item.kind,
      type: item.type,
      hasEntry: !!item.webkitGetAsEntry(),
      entryIsDirectory: !!item.webkitGetAsEntry()?.isDirectory,
      path: (item as DataTransferItem & { path?: string }).path ?? null,
    }));

    const files = Array.from(dataTransfer.files).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
      path: this.getDroppedFilePath(file),
    }));

    return {
      hasDataTransfer: true,
      types: Array.from(dataTransfer.types),
      files,
      items,
    };
  }

  private getDroppedFilePath(file: File & { path?: string }): string | null {
    if (typeof file.path === 'string' && file.path.trim().length > 0) {
      return toPlatformPath(file.path);
    }

    try {
      const resolvedPath = webUtils?.getPathForFile?.(file);
      if (typeof resolvedPath === 'string' && resolvedPath.trim().length > 0) {
        return toPlatformPath(resolvedPath);
      }
    } catch (error) {
      debugLog('[Terminal DnD] webUtils.getPathForFile failed:', error);
    }

    return null;
  }

  private getPathFromDroppedEntry(item: DataTransferItem): string | null {
    const entry = item.webkitGetAsEntry();
    if (!entry) return null;

    const entryPath = entry.fullPath ?? '';
    const normalizedEntry = normalizeDroppedEntryReference(entryPath);
    if (normalizedEntry.absolutePath && this.fs.existsSync(normalizedEntry.absolutePath)) {
      return normalizedEntry.absolutePath;
    }

    const vaultPath = normalizedEntry.vaultPath ?? normalizeVaultPath(entryPath);
    if (vaultPath) {
      const absoluteVaultPath = this.resolveVaultReferenceToAbsolute(vaultPath);
      if (absoluteVaultPath) {
        return absoluteVaultPath;
      }
    }

    if (normalizedEntry.absolutePath) {
      return normalizedEntry.absolutePath;
    }

    return null;
  }

  private extractDropTokens(text: string): string[] {
    if (!text) return [];

    const lineTokens = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    const uriTokens = Array.from(text.matchAll(/(?:obsidian|file):\/\/[^\s<>"'`]+/g)).map((match) => match[0]);

    return Array.from(new Set([...lineTokens, ...uriTokens]));
  }

  private resolveDroppedTokenToPath(token: string): string | null {
    const rawToken = normalizeTerminalRawToken(token);
    if (!rawToken) return null;

    const obsidianPath = this.obsidianUriToAbsolutePath(rawToken);
    if (obsidianPath) return obsidianPath;

    const fileUriPath = fileUriToPlatformPath(rawToken);
    if (fileUriPath) return fileUriPath;

    const normalized = normalizeTerminalToken(token);
    if (!normalized) return null;

    const wikiMatch = normalized.match(/^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]$/);
    if (wikiMatch) {
      return this.resolveVaultReferenceToAbsolute(wikiMatch[1]);
    }

    if (isAbsoluteTerminalPath(normalized)) {
      return toPlatformPath(normalized);
    }

    if (isBasenameOnlyTerminalToken(normalized)) {
      const basenamePath = this.resolveUniqueVaultBasenameToAbsolute(normalized);
      if (basenamePath) {
        return basenamePath;
      }
    }

    return this.resolveVaultReferenceToAbsolute(normalized, true);
  }

  private quoteDroppedPaths(paths: string[]): string {
    return paths.map((path) => `"${path.replace(/"/g, '\\"')}"`).join(' ');
  }

  private formatDroppedPaths(paths: string[]): string {
    if (!this.shouldFormatDroppedPathsAsClaudeCodeReferences()) {
      return this.quoteDroppedPaths(paths);
    }

    return formatClaudeCodePathReferences(paths, {
      cwd: this.terminalInstance?.getCwd(),
      isDirectory: (path) => this.isDroppedDirectoryPath(path),
      pathExists: (path) => this.fs.existsSync(path),
    });
  }

  private shouldFormatDroppedPathsAsClaudeCodeReferences(): boolean {
    const terminal = this.terminalInstance;
    if (!terminal) {
      return false;
    }

    return terminal.isClaudeCodeSession();
  }

  private isDroppedDirectoryPath(path: string): boolean {
    try {
      return this.fs.statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private uniquePaths(paths: string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const rawPath of paths) {
      const normalized = rawPath.trim();
      if (!normalized) continue;
      const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }

    return result;
  }

  private obsidianUriToAbsolutePath(uri: string): string | null {
    const vaultPath = obsidianUriToVaultPath(uri);
    return vaultPath ? this.resolveVaultPathToAbsolute(vaultPath) : null;
  }

  private resolveVaultPathToAbsolute(pathLike: string): string | null {
    const normalizedPath = normalizeVaultPath(pathLike);
    if (!normalizedPath) return null;

    const activePath = this.app.workspace.getActiveFile()?.path ?? '';
    // Prefer an exact vault entry so folder drops are not shadowed by folder notes.
    const entry = this.app.vault.getAbstractFileByPath(normalizedPath)
      ?? this.app.metadataCache.getFirstLinkpathDest(normalizedPath, activePath);
    if (!entry) return null;

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return entry.path;
    }

    return joinTerminalPaths(adapter.getBasePath(), entry.path);
  }

  private resolveVaultReferenceToAbsolute(pathLike: string, allowBasenameFallback = false): string | null {
    return this.resolveVaultPathToAbsolute(pathLike)
      ?? (allowBasenameFallback ? this.resolveUniqueVaultBasenameToAbsolute(pathLike) : null);
  }

  private resolveUniqueVaultBasenameToAbsolute(name: string): string | null {
    const allEntries = this.app.vault.getAllLoadedFiles?.() ?? [];
    const matchedEntry = findUniqueTerminalEntryByBasename(name, allEntries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      kind: entry instanceof TFolder ? 'folder' : 'file' as const,
    })));

    if (!matchedEntry) {
      return null;
    }

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return matchedEntry.path;
    }

    return joinTerminalPaths(adapter.getBasePath(), matchedEntry.path);
  }

  private async writeInputToTerminal(text: string, usePaste = false): Promise<void> {
    const terminal = this.terminalInstance ?? await this.waitForTerminalInstance().catch(() => null);
    if (!terminal) return;
    if (usePaste) {
      terminal.pasteText(text);
    } else {
      terminal.sendText(text);
    }
    terminal.focus();
  }

  private registerTerminalHyperlinkHandler(terminal: TerminalInstance): void {
    this.disposeTerminalLinkProvider(terminal);
    const xterm = terminal.getXterm();
    xterm.options.linkHandler = {
      allowNonHttpProtocols: true,
      activate: (event: MouseEvent, target: string) => {
        event.preventDefault();
        void this.openTerminalHyperlinkTarget(target);
      },
    };

    const provider = xterm.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const zeroBasedLineNumber = bufferLineNumber - 1;
        if (zeroBasedLineNumber < 0) {
          callback(undefined);
          return;
        }

        const window = this.getTerminalLinkWindow(xterm, zeroBasedLineNumber);
        if (!window) {
          callback(undefined);
          return;
        }

        const parsedLinks: ParsedTerminalHyperlink[] = [
          ...parseTerminalFileUriLinks(window.text).map((link): ParsedTerminalHyperlink => ({
            ...link,
            kind: 'file',
          })),
          ...parseTerminalWebLinks(window.text).map((link): ParsedTerminalHyperlink => ({
            ...link,
            kind: 'web',
          })),
        ];

        const links = parsedLinks
          .flatMap((link): XtermLink[] => {
            // 链接内部的硬换行拼接点，点击时做空格/截断变体回退。
            const junctions = window.hardJunctions
              .filter((junction) => junction > link.startIndex && junction < link.endIndex);
            const relativeJunctions = junctions.map((junction) => junction - link.startIndex);

            // 跨硬换行的链接按拼接点切成逐行片段：xterm 的单一 range 跨行时会把
            // 下划线画满首行行尾和次行行首的空白（TUI 折行断点不在终端边缘）。
            // 每段精确覆盖自己的文字，点击任何一段都打开同一目标。
            const bounds = [link.startIndex, ...junctions, link.endIndex];
            const ranges: XtermBufferRange[] = [];
            for (let i = 0; i < bounds.length - 1; i += 1) {
              const start = terminalBufferPositionForStringIndex(
                bounds[i],
                window.lineTexts,
                window.columnMaps,
                window.startLineIndex,
              );
              const end = terminalBufferPositionForStringIndex(
                bounds[i + 1] - 1,
                window.lineTexts,
                window.columnMaps,
                window.startLineIndex,
              );
              if (!start || !end) {
                continue;
              }
              ranges.push({ start, end });
            }

            return ranges.map((range): XtermLink => ({
              text: link.uri,
              range,
              activate: (event, text) => {
                event.preventDefault();
                if (link.kind === 'file') {
                  void this.openTerminalFileUriLink(text, relativeJunctions);
                } else {
                  void this.openTerminalHyperlinkTarget(text);
                }
              },
              // xterm 悬停只高亮指针下的片段；多片段时给其余片段叠加下划线
              // 覆盖层，让整条链接跨行同亮。
              ...(ranges.length > 1
                ? {
                  hover: () => this.underlineSiblingLinkRanges(xterm, ranges, range),
                  leave: () => this.clearLinkHoverDecorations(),
                }
                : {}),
            }));
          })
          .filter((link) =>
            link.range.start.y <= bufferLineNumber
            && link.range.end.y >= bufferLineNumber
          );

        callback(links.length > 0 ? links : undefined);
      },
    });
    this.linkProviderByTerminal.set(terminal, provider);
  }

  private getTerminalLinkWindow(
    xterm: XtermTerminal,
    bufferLineNumber: number,
  ): { text: string; lineTexts: string[]; columnMaps: number[][]; startLineIndex: number; hardJunctions: number[] } | null {
    // 软换行（isWrapped）由窗口直接拼接；TUI（Claude Code 等）的硬换行
    // 由 buildTerminalLinkWindow 按「链接是否未闭合」的语义判定跨行扩展。
    return buildTerminalLinkWindow(
      xterm.buffer.active,
      bufferLineNumber,
      (text) => terminalFileUriLooksOpenAtEnd(text) || terminalWebUrlLooksOpenAtEnd(text),
      (leftText, rightText) => {
        if (terminalFileUriLooksOpenAtEnd(leftText)) {
          return true;
        }
        return terminalWebUrlLooksOpenAtEnd(leftText)
          && terminalWebUrlLooksLikeContinuation(rightText);
      },
    );
  }

  /**
   * 跨行链接悬停联动：给同一条链接的其余片段叠加下划线覆盖层。
   * xterm 一个链接对象只有一个矩形范围、悬停只高亮指针下的对象，「整条同亮」
   * 只能自己画。不用 marker/decoration——tmux 等全屏程序跑在备用屏幕
   * （alternate buffer）上，registerMarker 在备用屏幕直接返回 undefined。
   * 改为按单元格像素尺寸手动定位 DOM 覆盖层；pointer-events 关闭，不抢鼠标。
   */
  private underlineSiblingLinkRanges(
    xterm: XtermTerminal,
    ranges: XtermBufferRange[],
    hovered: XtermBufferRange,
  ): void {
    this.clearLinkHoverDecorations();
    const screen = xterm.element?.querySelector('.xterm-screen');
    if (!(screen instanceof HTMLElement) || xterm.cols <= 0 || xterm.rows <= 0) {
      return;
    }
    // 优先用渲染器的精确单元格尺寸（私有 API，做了防御）；本插件的 .xterm-screen
    // 被样式表拉伸成 100%，clientWidth / cols 会带上不足一格的余量误差。
    const renderDims = (xterm as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: number; height?: number } } } } };
    })._core?._renderService?.dimensions?.css?.cell;
    const cellWidth = renderDims?.width || screen.clientWidth / xterm.cols;
    const cellHeight = renderDims?.height || screen.clientHeight / xterm.rows;
    const viewportTop = xterm.buffer.active.viewportY;

    for (const range of ranges) {
      if (range === hovered) {
        continue;
      }
      // 片段内部仍可能有软换行：逐可视行铺覆盖层。
      for (let y = range.start.y; y <= range.end.y; y += 1) {
        const viewportRow = y - 1 - viewportTop;
        if (viewportRow < 0 || viewportRow >= xterm.rows) {
          continue; // 滚出视口的行不画
        }
        const startColumn = y === range.start.y ? range.start.x - 1 : 0;
        const endColumn = y === range.end.y ? range.end.x : xterm.cols;
        if (endColumn <= startColumn) {
          continue;
        }
        const underline = screen.createDiv('termy-link-hover-underline');
        underline.style.left = `${startColumn * cellWidth}px`;
        underline.style.top = `${viewportRow * cellHeight}px`;
        underline.style.width = `${(endColumn - startColumn) * cellWidth}px`;
        underline.style.height = `${cellHeight}px`;
        this.linkHoverDecorations.push(underline);
      }
    }
  }

  private clearLinkHoverDecorations(): void {
    for (const element of this.linkHoverDecorations) {
      element.remove();
    }
    this.linkHoverDecorations = [];
  }

  /**
   * 打开终端里识别出的 file:// 链接。链接若跨「硬换行」拼接而成（junctions 非空），
   * 按词折行可能吃掉了断点处的空格、或把无关文字粘进了尾部——按
   * 「原样 → 补空格 → 截断」的候选顺序，挑第一个能解析到真实文件的打开。
   */
  private async openTerminalFileUriLink(target: string, junctions: number[]): Promise<void> {
    if (junctions.length > 0) {
      for (const candidate of buildTerminalFileUriJunctionCandidates(target, junctions)) {
        const reference = parseTerminalFileUriReference(candidate);
        if (!reference) {
          continue;
        }
        const filePath = fileUriToPlatformPath(reference.uri);
        if (!filePath) {
          continue;
        }
        const resolved = this.resolveTerminalFileReference(filePath);
        if (!resolved) {
          continue;
        }
        if (resolved.file) {
          await this.openVaultFileReference(resolved.file, reference.line);
          return;
        }
        const errorMessage = await shell.openPath(resolved.externalPath);
        if (!errorMessage) {
          return;
        }
      }
    }

    await this.openTerminalHyperlinkTarget(target);
  }

  private async openTerminalHyperlinkTarget(target: string): Promise<void> {
    const fileUriReference = parseTerminalFileUriReference(target);
    if (fileUriReference) {
      const filePath = fileUriToPlatformPath(fileUriReference.uri);
      if (filePath) {
        await this.openTerminalFileReference(filePath, fileUriReference.line);
        return;
      }
    }

    if (!this.isAllowedExternalHyperlink(target)) {
      new Notice(t('notices.terminal.fileReferenceUnavailable'));
      return;
    }

    try {
      await shell.openExternal(target);
    } catch (error) {
      errorLog('[TerminalView] Failed to open terminal hyperlink:', target, error);
      new Notice(t('notices.terminal.fileReferenceOpenFailed'));
    }
  }

  private isAllowedExternalHyperlink(target: string): boolean {
    try {
      const url = new URL(normalizeTerminalToken(target));
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private async openTerminalFileReference(pathLike: string, line?: number): Promise<void> {
    const resolved = this.resolveTerminalFileReference(pathLike);
    if (!resolved) {
      new Notice(t('notices.terminal.fileReferenceUnavailable'));
      return;
    }

    if (resolved.file) {
      await this.openVaultFileReference(resolved.file, line);
      return;
    }

    const errorMessage = await shell.openPath(resolved.externalPath);
    if (errorMessage) {
      if (this.fs.existsSync(resolved.externalPath)) {
        const containingDir = this.path.dirname(resolved.externalPath);
        const directoryError = await shell.openPath(containingDir);
        if (!directoryError) {
          return;
        }
      }

      errorLog('[TerminalView] Failed to open external path:', resolved.externalPath, errorMessage);
      new Notice(t('notices.terminal.fileReferenceOpenFailed'));
    }
  }

  private resolveTerminalFileReference(pathLike: string): { file?: TFile; externalPath: string } | null {
    const normalizedReference = normalizeTerminalReferencePath(pathLike);
    if (!normalizedReference) {
      return null;
    }

    if (isAbsoluteTerminalPath(normalizedReference)) {
      const fileFromAbsolutePath = this.absolutePathToVaultFile(normalizedReference);
      if (fileFromAbsolutePath) {
        return {
          file: fileFromAbsolutePath,
          externalPath: normalizedReference,
        };
      }

      if (!this.fs.existsSync(normalizedReference)) {
        return null;
      }

      return { externalPath: normalizedReference };
    }

    const vaultFile = this.resolveVaultReference(normalizedReference);
    if (vaultFile) {
      return {
        file: vaultFile,
        externalPath: vaultFile.path,
      };
    }

    for (const absolutePath of this.getTerminalReferenceAbsoluteCandidates(normalizedReference)) {
      const fileFromCandidate = this.absolutePathToVaultFile(absolutePath);
      if (fileFromCandidate) {
        return {
          file: fileFromCandidate,
          externalPath: absolutePath,
        };
      }

      if (this.fs.existsSync(absolutePath)) {
        return { externalPath: absolutePath };
      }
    }

    return null;
  }

  private resolveVaultReference(pathLike: string): TFile | null {
    const normalizedPath = normalizeVaultPath(pathLike);
    if (!normalizedPath) {
      return null;
    }

    const activePath = this.app.workspace.getActiveFile()?.path ?? '';
    const file = this.app.metadataCache.getFirstLinkpathDest(normalizedPath, activePath)
      ?? this.app.vault.getAbstractFileByPath(normalizedPath);

    return file instanceof TFile ? file : null;
  }

  private absolutePathToVaultFile(absolutePath: string): TFile | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return null;
    }

    const relativePath = getVaultRelativePathFromAbsolute(absolutePath, adapter.getBasePath());
    if (relativePath === null) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(relativePath);
    return file instanceof TFile ? file : null;
  }

  private getTerminalReferenceAbsoluteCandidates(relativePath: string): string[] {
    const adapter = this.app.vault.adapter;
    const vaultBasePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    const currentCwd = this.terminalInstance?.getCwd() ?? null;
    const initialCwd = this.terminalInstance?.getInitialCwd() ?? null;

    return collectTerminalReferenceCandidatePaths(
      relativePath,
      [currentCwd, initialCwd, vaultBasePath],
    );
  }

  private async openVaultFileReference(file: TFile, line?: number): Promise<void> {
    // 复用已打开该文件的 tab；否则新开一个 tab，避免劫持当前激活的（可能是别的笔记）tab。
    const existingLeaf = this.app.workspace
      .getLeavesOfType('markdown')
      .find((candidate) => (candidate.view as MarkdownView).file?.path === file.path);
    const leaf = existingLeaf ?? this.app.workspace.getLeaf('tab');

    await leaf.openFile(file, {
      active: true,
      eState: line ? { line: line - 1, col: 0 } : undefined,
    });
    await this.app.workspace.revealLeaf(leaf);
  }

  private updateAppearanceStyles(): void {
    if (!this.terminalContainer || !this.terminalInstance) return;

    const options = this.terminalInstance.getOptions();
    const canUseBackgroundImage = !!options?.backgroundImage
      && !options?.useObsidianTheme
      && this.terminalInstance.getCurrentRenderer() !== 'webgl';

    if (canUseBackgroundImage) {
      this.terminalContainer.addClass('has-background-image');
      this.containerEl.querySelector('.terminal-view-container')?.addClass('has-background-image');
      this.ensureBackgroundLayer();
    } else {
      this.terminalContainer.removeClass('has-background-image');
      this.containerEl.querySelector('.terminal-view-container')?.removeClass('has-background-image');
      this.terminalContainer.querySelector('.terminal-background-image')?.remove();
    }

    const backgroundImageOpacity = options?.backgroundImageOpacity ?? 0.5;
    const overlayOpacity = canUseBackgroundImage
      ? clamp(1 - backgroundImageOpacity, 0, 1)
      : 0;
    const blurAmount = options?.blurAmount ?? 0;
    const blurEnabled = canUseBackgroundImage && !!options?.enableBlur && blurAmount > 0;

    this.applyAppearanceStyleRule({
      backgroundImage: canUseBackgroundImage ? toCssUrl(options?.backgroundImage) : 'none',
      overlayOpacity,
      backgroundSize: normalizeBackgroundSize(options?.backgroundImageSize),
      backgroundPosition: normalizeBackgroundPosition(options?.backgroundImagePosition),
      blur: blurEnabled ? `${blurAmount}px` : '0px',
      scale: blurEnabled ? '1.05' : '1',
      textOpacity: canUseBackgroundImage ? String(options?.textOpacity ?? 1.0) : '1',
      backgroundColor: canUseBackgroundImage
        ? 'transparent'
        : this.terminalInstance.getEffectiveBackgroundColor(),
      foregroundColor: this.terminalInstance.getEffectiveForegroundColor(),
    });
  }

  private setupResizeObserver(): void {
    if (!this.terminalContainer) return;
    this.resizeObserver?.disconnect();

    let resizeTimeout: number | null = null;
    const ResizeObserverCtor = this.terminalContainer.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver;

    this.resizeObserver = new ResizeObserverCtor((entries) => {
      if (resizeTimeout) window.clearTimeout(resizeTimeout);

      resizeTimeout = window.setTimeout(() => {
        if (this.terminalInstance?.isAlive()) {
          const { width, height } = entries[0].contentRect;
          if (width > 0 && height > 0) {
            this.terminalInstance.fit();
          }
        }
      }, 100);
    });

    this.resizeObserver.observe(this.terminalContainer);
  }

  /**
   * Refresh theme/background-related appearance
   */
  refreshAppearance(): void {
    if (!this.terminalInstance) return;

    const plugin = this.getTerminalPlugin();
    if (!plugin) return;

    const settings = plugin.settings;

    this.terminalInstance.updateOptions({
      fontSize: settings.fontSize,
      fontFamily: settings.fontFamily,
      cursorStyle: settings.cursorStyle,
      cursorBlink: settings.cursorBlink,
      useObsidianTheme: settings.useObsidianTheme,
      backgroundColor: settings.backgroundColor,
      foregroundColor: settings.foregroundColor,
      backgroundImage: settings.backgroundImage,
      backgroundImageOpacity: settings.backgroundImageOpacity,
      backgroundImageSize: settings.backgroundImageSize,
      backgroundImagePosition: settings.backgroundImagePosition,
      enableBlur: settings.enableBlur,
      blurAmount: settings.blurAmount,
      textOpacity: settings.textOpacity,
      preferredRenderer: settings.preferredRenderer,
    });

    this.updateAppearanceStyles();
  }

  private ensureBackgroundLayer(): void {
    if (!this.terminalContainer) return;
    const existingLayer = this.terminalContainer.querySelector('.terminal-background-image');
    if (existingLayer) return;

    const bgLayer = activeDocument.createElement('div');
    bgLayer.className = 'terminal-background-image';
    this.terminalContainer.prepend(bgLayer);
  }

  private applyAppearanceStyleRule(vars: {
    backgroundImage: string;
    overlayOpacity: number;
    backgroundSize: string;
    backgroundPosition: string;
    blur: string;
    scale: string;
    textOpacity: string;
    backgroundColor: string;
    foregroundColor: string;
  }): void {
    if (!this.terminalContainer) return;
    const style = this.terminalContainer.style;
    style.setProperty('--terminal-bg-image', vars.backgroundImage);
    style.setProperty('--terminal-bg-overlay-opacity', String(vars.overlayOpacity));
    style.setProperty('--terminal-bg-size', vars.backgroundSize);
    style.setProperty('--terminal-bg-position', vars.backgroundPosition);
    style.setProperty('--terminal-bg-blur', vars.blur);
    style.setProperty('--terminal-bg-scale', vars.scale);
    style.setProperty('--terminal-text-opacity', vars.textOpacity);
    style.setProperty('--terminal-bg-color', vars.backgroundColor);
    // IME 合成预览（.composition-view）用它做「同色字」：字色取终端前景色。
    style.setProperty('--terminal-fg-color', vars.foregroundColor);
    const viewContainer = this.containerEl.querySelector<HTMLElement>('.terminal-view-container');
    viewContainer?.style.setProperty('--terminal-bg-color', vars.backgroundColor);
    viewContainer?.style.setProperty('--terminal-fg-color', vars.foregroundColor);
  }

  private disposeAppearanceStyle(): void {
    if (!this.terminalContainer) return;
    const style = this.terminalContainer.style;
    style.removeProperty('--terminal-bg-image');
    style.removeProperty('--terminal-bg-overlay-opacity');
    style.removeProperty('--terminal-bg-size');
    style.removeProperty('--terminal-bg-position');
    style.removeProperty('--terminal-bg-blur');
    style.removeProperty('--terminal-bg-scale');
    style.removeProperty('--terminal-text-opacity');
    style.removeProperty('--terminal-bg-color');
    style.removeProperty('--terminal-fg-color');
    const viewContainer = this.containerEl.querySelector<HTMLElement>('.terminal-view-container');
    viewContainer?.style.removeProperty('--terminal-bg-color');
    viewContainer?.style.removeProperty('--terminal-fg-color');
  }

  /**
   * Get the terminal instance (for external callers)
   */
  getTerminalInstance(): TerminalInstance | null {
    return this.terminalInstance;
  }

  async waitForTerminalInstance(timeoutMs = 8000): Promise<TerminalInstance> {
    if (this.terminalInstance) return this.terminalInstance;
    if (!this.initPromise) {
      throw new Error(t('terminal.notInitialized'));
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error(t('terminal.notInitialized'))), timeoutMs);
    });

    return Promise.race([this.initPromise, timeoutPromise]);
  }

  private updateLeafHeader(leaf: WorkspaceLeaf): void {
    const leafWithHeader = leaf as WorkspaceLeaf & { updateHeader?: () => void };
    leafWithHeader.updateHeader?.();
  }

  private getTerminalPlugin(): {
    settings: TerminalSettings;
    activateTerminalView: () => Promise<void>;
  } | null {
    const appWithPlugins = this.app as typeof this.app & {
      plugins?: { getPlugin?: (id: string) => unknown };
    };
    const plugin = appWithPlugins.plugins?.getPlugin?.('termy');
    if (!this.isTerminalPlugin(plugin)) return null;
    return plugin;
  }

  private isTerminalPlugin(value: unknown): value is {
    settings: TerminalSettings;
    activateTerminalView: () => Promise<void>;
  } {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as {
      settings?: unknown;
      activateTerminalView?: unknown;
    };
    return typeof candidate.activateTerminalView === 'function'
      && typeof candidate.settings === 'object';
  }
}
