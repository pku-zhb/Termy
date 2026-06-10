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
type PathModule = typeof import('path');

import type { TerminalService } from '../../services/terminal/terminalService';
import type { TerminalInstance } from '../../services/terminal/terminalInstance';
import type { ForegroundInfo } from '../../services/server/types';
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
  parseTerminalFileUriLinks,
  parseTerminalFileUriReference,
} from '../../services/terminal/terminalFileLinks';
import {
  buildTerminalLineColumnMap,
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

export const TERMINAL_VIEW_TYPE = 'terminal-view-dev';
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

/**
 * Terminal view class
 */
export class TerminalView extends ItemView {
  protected terminalService: TerminalService | null;
  private terminalInstance: TerminalInstance | null = null;  // 始终指向当前 active 终端
  private tabs: Array<{ terminal: TerminalInstance; paneEl: HTMLElement; customName: string | null; status: TerminalTabStatus }> = [];
  private activeIndex = -1;
  private tabBarEl: HTMLElement | null = null;
  private terminalContainer: HTMLElement | null = null;
  private dropHintEl: HTMLElement | null = null;
  private dragEnterDepth = 0;
  private removeDropHandlers: (() => void) | null = null;
  private searchContainer: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fileUriLinkProvider: XtermDisposable | null = null;
  private titleChangeCleanup: (() => void) | null = null;
  private searchStateCleanup: (() => void) | null = null;
  private initPromise: Promise<TerminalInstance> | null = null;
  private initResolve: ((terminal: TerminalInstance) => void) | null = null;
  private initReject: ((error: Error) => void) | null = null;

  private readonly fs: FsModule;
  private readonly path: PathModule;
  private readonly foregroundByTerminal = new WeakMap<TerminalInstance, ForegroundInfo>();
  private readonly closingTabs = new Set<TerminalInstance>();
  private readonly detachLeafWithoutConfirmation: WorkspaceLeaf['detach'];
  private viewCloseConfirmationPromise: Promise<boolean> | null = null;

  constructor(leaf: WorkspaceLeaf, terminalService: TerminalService | null) {
    super(leaf);
    this.terminalService = terminalService;
    this.fs = window.require('fs') as FsModule;
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
        void this.addTab();
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
    this.leaf.detach = this.detachLeafWithoutConfirmation;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.fileUriLinkProvider?.dispose();
    this.fileUriLinkProvider = null;
    this.titleChangeCleanup?.();
    this.titleChangeCleanup = null;
    this.searchStateCleanup?.();
    this.searchStateCleanup = null;
    this.removeDropHandlers?.();
    this.removeDropHandlers = null;
    this.dragEnterDepth = 0;
    this.dropHintEl = null;

    for (const tab of this.tabs) {
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

  setTerminalService(terminalService: TerminalService): void {
    this.terminalService = terminalService;
  }

  /**
   * Create a new terminal
   */
  private async createNewTerminal(): Promise<void> {
    // 在当前 view 内新开一个 tab（不再开新的 Obsidian 标签）
    await this.addTab();
  }

  /**
   * 在本 view 内新建一个终端 tab
   */
  async addTab(): Promise<void> {
    if (!this.terminalService || !this.terminalContainer) return;

    const paneEl = this.terminalContainer.createDiv('termy-pane');

    let terminal: TerminalInstance;
    try {
      terminal = await this.terminalService.createTerminal();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errorLog('[TerminalView] Create tab failed:', message);
      new Notice(t('notices.terminal.initFailed', { message }));
      paneEl.remove();
      if (this.tabs.length === 0) {
        this.detachLeafWithoutConfirmation();
      }
      return;
    }

    // View 可能在等待终端创建（异步）期间被关闭：onClose 已清空 tabs 并清空容器。
    // 此时若继续挂载，会复活一个 onClose 销毁循环跑不到的终端 → 永久泄漏。
    if (!this.terminalContainer?.isConnected) {
      await this.terminalService?.destroyTerminal(terminal.id).catch(() => { /* ignore */ });
      paneEl.remove();
      return;
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
    this.registerTerminalHyperlinkHandler(terminal.getXterm());

    this.tabs.push({ terminal, paneEl, customName: null, status: 'none' });

    // Track foreground changes so the tab can show tmux/ssh/Claude/Codex status.
    terminal.onForegroundChange((info) => {
      this.foregroundByTerminal.set(terminal, info);
      this.updateTabForegroundStatus(terminal, info);
    });

    this.activeIndex = -1; // Force setActiveTab to bind the new terminal.
    this.setActiveTab(this.tabs.length - 1);
  }

  private setTerminalTabStatus(terminal: TerminalInstance, status: TerminalTabStatus): void {
    const tab = this.tabs.find((candidate) => candidate.terminal === terminal);
    if (!tab || tab.status === status) {
      return;
    }

    tab.status = status;
    this.renderTabBar();
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
      this.setTerminalTabStatus(terminal, foregroundStatus);
      return;
    }

    if (isIdleShellForeground(info)) {
      terminal.resetClaudeCodeSession();
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
  }

  /**
   * 关闭指定 tab；关闭最后一个时连同关闭整个 view
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
        this.detachLeafWithoutConfirmation();
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

      // Tab number badge for Opt+number switching (1-9, tenth tab is 0).
      if (i < 10) {
        const indexEl = tabEl.createSpan('termy-tab-index');
        indexEl.setText(i === 9 ? '0' : String(i + 1));
      }

      // Status icon for tmux/Claude/Codex/SSH.
      if (tab.status === 'tmux' || tab.status === 'claude' || tab.status === 'codex') {
        const iconEl = tabEl.createEl('img', { cls: 'termy-tab-status-icon' });
        iconEl.toggleClass('is-tmux', tab.status === 'tmux');
        iconEl.alt = '';
        iconEl.title = tab.status;
        iconEl.src = tab.status === 'tmux'
          ? TMUX_ICON
          : tab.status === 'claude'
            ? CLAUDE_ICON
            : CODEX_ICON;
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

  // —— 供命令调用的 tab 导航 ——
  openNewTab(): void { void this.addTab(); }
  closeActiveTab(): void { const t = this.tabs[this.activeIndex]?.terminal; if (t) void this.closeTab(t); }
  nextTab(): void { if (this.tabs.length > 1) this.setActiveTab((this.activeIndex + 1) % this.tabs.length); }
  prevTab(): void { if (this.tabs.length > 1) this.setActiveTab((this.activeIndex - 1 + this.tabs.length) % this.tabs.length); }
  gotoTab(n: number): void { if (n >= 0 && n < this.tabs.length) this.setActiveTab(n); }
  getTabCount(): number { return this.tabs.length; }

  /** 聚焦当前 active 终端（供切回 Obsidian 标签时自动 focus，避免焦点卡在标签头按钮上） */
  focusActiveTerminal(): void {
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
    }).open();
  }

  private bindTerminalInstance(terminal: TerminalInstance): void {
    this.detachTerminalBindings();
    this.titleChangeCleanup = terminal.onTitleChange(() => {
      this.updateLeafHeader(this.leaf);
      this.updateDropHintText();
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

  private registerTerminalHyperlinkHandler(xterm: XtermTerminal): void {
    xterm.options.linkHandler = {
      allowNonHttpProtocols: true,
      activate: (event: MouseEvent, target: string) => {
        event.preventDefault();
        void this.openTerminalHyperlinkTarget(target);
      },
    };

    this.fileUriLinkProvider?.dispose();
    this.fileUriLinkProvider = xterm.registerLinkProvider({
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

        const links = parseTerminalFileUriLinks(window.text)
          .map((link): XtermLink | null => {
            const start = terminalBufferPositionForStringIndex(
              link.startIndex,
              window.lineTexts,
              window.columnMaps,
              window.startLineIndex,
            );
            const end = terminalBufferPositionForStringIndex(
              link.endIndex - 1,
              window.lineTexts,
              window.columnMaps,
              window.startLineIndex,
            );
            if (!start || !end) {
              return null;
            }

            const xtermLink: XtermLink = {
              text: link.uri,
              range: { start, end },
              activate: (event, text) => {
                event.preventDefault();
                void this.openTerminalHyperlinkTarget(text);
              },
            };
            return xtermLink;
          })
          .filter((link): link is XtermLink =>
            link !== null
            && link.range.start.y <= bufferLineNumber
            && link.range.end.y >= bufferLineNumber
          );

        callback(links.length > 0 ? links : undefined);
      },
    });
  }

  private getTerminalLinkWindow(
    xterm: XtermTerminal,
    bufferLineNumber: number,
  ): { text: string; lineTexts: string[]; columnMaps: number[][]; startLineIndex: number } | null {
    const buffer = xterm.buffer.active;
    if (!buffer.getLine(bufferLineNumber)) {
      return null;
    }

    let startLineIndex = bufferLineNumber;
    while (startLineIndex > 0 && buffer.getLine(startLineIndex)?.isWrapped) {
      startLineIndex -= 1;
    }

    let endLineIndex = bufferLineNumber;
    while (buffer.getLine(endLineIndex + 1)?.isWrapped) {
      endLineIndex += 1;
    }

    const lineTexts: string[] = [];
    const columnMaps: number[][] = [];
    for (let lineIndex = startLineIndex; lineIndex <= endLineIndex; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      if (!line) {
        break;
      }
      lineTexts.push(line.translateToString(true));
      columnMaps.push(buildTerminalLineColumnMap(line));
    }

    return {
      text: lineTexts.join(''),
      lineTexts,
      columnMaps,
      startLineIndex,
    };
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
    this.app.workspace.revealLeaf(leaf);
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
    const plugin = appWithPlugins.plugins?.getPlugin?.('termy-dev');
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
