import type { View, WorkspaceLeaf } from 'obsidian';
import { addIcon, FileSystemAdapter, Modal, Notice, Plugin, normalizePath, setIcon, setTooltip } from 'obsidian';
import {
  DEFAULT_PRESET_SCRIPTS,
  DEFAULT_TERMINAL_SETTINGS,
  type PresetScript,
  type PresetWorkflowAction,
  type TerminalSettings,
} from './settings/settings';
import { PresetScriptModal } from './ui/terminal/presetScriptModal';
import { renderPresetScriptIcon } from './ui/terminal/presetScriptIcons';
import { TerminalSettingTab } from './settings/settingsTab';
import type { TerminalService } from './services/terminal/terminalService';
import type { ServerManager } from './services/server/serverManager';
import type { AgentStatusService } from './services/agentStatus/agentStatusService';
import { TerminalRestoreStore, hasRestorableAgentTabs } from './services/terminal/terminalRestoreState';
import { TERMINAL_VIEW_TYPE, TerminalView } from './ui/terminal/terminalView';
import { i18n, t } from './i18n';
import { debugLog, errorLog } from './utils/logger';
import { createTermyLogoSvg, createTermyLogoSvgMarkup, TERMY_RIBBON_ICON_ID } from './ui/icons';
import { FeatureVisibilityManager } from './services/visibility';
import { shell } from 'electron';
import type { TerminalInstance } from './services/terminal/terminalInstance';

// Import terminal styles

/**
 * Main class for the Obsidian Terminal plugin
 */
export default class TerminalPlugin extends Plugin {
  settings!: TerminalSettings;
  featureVisibilityManager!: FeatureVisibilityManager;
  
  // Lazily initialized services
  private _serverManager: ServerManager | null = null;
  private _terminalService: TerminalService | null = null;
  private _agentStatusService: AgentStatusService | null = null;
  private _terminalRestoreStore: TerminalRestoreStore | null = null;
  
  // Status bar elements
  private _statusBarItem: HTMLElement | null = null;
  private _presetScriptsMenuEl: HTMLElement | null = null;
  private _presetScriptsMenuCleanup: (() => void) | null = null;
  /**
   * Listeners notified when a launcher snapshot is updated. The settings
   * page subscribes so its rows stay in sync when offline mode toggles
   * or the user opts in to update checks while the page is open.
   */
  // Registered preset script commands
  private registeredPresetScriptCommandIds: Set<string> = new Set();

  /**
   * Get the server manager (lazy initialization)
   */
  async getServerManager(): Promise<ServerManager> {
    if (!this._serverManager) {
      debugLog('[TerminalPlugin] Initializing ServerManager...');
      
      const { ServerManager } = await import('./services/server/serverManager');
      
      const pluginDir = this.getPluginDir();
      const version = this.manifest.version;
      
      this._serverManager = new ServerManager(
        pluginDir,
        version,
        this.settings.enableDebugLog
      );
      
      debugLog('[TerminalPlugin] ServerManager initialized');
    }
    return this._serverManager;
  }

  /**
   * Get the terminal service (lazy initialization)
   */
  async getTerminalService(): Promise<TerminalService> {
    if (!this._terminalService) {
      debugLog('[TerminalPlugin] Initializing TerminalService...');
      
      const { TerminalService } = await import('./services/terminal/terminalService');
      
      const serverManager = await this.getServerManager();
        this._terminalService = new TerminalService(
          this.app,
          this.settings,
          serverManager,
          () => ({}),
          () => this.saveSettings(),
        );
      
      debugLog('[TerminalPlugin] TerminalService initialized');
    }
    return this._terminalService;
  }

  async getAgentStatusService(): Promise<AgentStatusService> {
    if (!this._agentStatusService) {
      debugLog('[TerminalPlugin] Initializing AgentStatusService...');
      const { AgentStatusService } = await import('./services/agentStatus/agentStatusService');
      this._agentStatusService = new AgentStatusService();
      debugLog('[TerminalPlugin] AgentStatusService initialized');
    }
    return this._agentStatusService;
  }

  getTerminalRestoreStore(): TerminalRestoreStore {
    if (!this._terminalRestoreStore) {
      this._terminalRestoreStore = TerminalRestoreStore.fromElectron(this.getVaultBasePath());
    }
    return this._terminalRestoreStore;
  }

  /**
   * Called when the plugin loads
   */
  async onload() {
    // Initialize the i18n service
    i18n.initialize();
    
    debugLog(t('plugin.loadingMessage'));

    // Load settings
    await this.loadSettings();

    // Set debug mode
    const { setDebugMode } = await import('./utils/logger');
    setDebugMode(this.settings.enableDebugLog);

    // Initialize the feature visibility manager
    this.featureVisibilityManager = new FeatureVisibilityManager(this);
    this.registerCustomIcons();

    // Register feature visibility configuration
    this.registerFeatureVisibility();

    // Register the terminal view
    this.registerView(
      TERMINAL_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => {
        // Create a placeholder view; the actual initialization happens when the user opens it
        return new TerminalViewPlaceholder(leaf, this);
      }
    );

    // Register all commands
    this.registerCommands();

    // Delay UI initialization until the layout is ready whenever possible
    this.app.workspace.onLayoutReady(() => {
      this.registerNewTabTerminalAction();
      this.registerTerminalAutoFocus();
      void this.restoreTerminalViewIfNeeded();
    });

    // Add the settings tab
    this.addSettingTab(new TerminalSettingTab(this.app, this));

    debugLog(t('plugin.loadedMessage'));
  }

  private async restoreTerminalViewIfNeeded(): Promise<void> {
    if (this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE).length > 0) {
      return;
    }

    try {
      const snapshot = await this.getTerminalRestoreStore().loadSnapshot();
      if (!hasRestorableAgentTabs(snapshot)) {
        return;
      }
      await this.activateTerminalView(this.getLeafForNewTerminal());
    } catch (error) {
      errorLog('[TerminalPlugin] Failed to restore Termy view:', error);
    }
  }

  /**
   * Called when the plugin unloads
   */
  onunload(): void {
    void this.handleUnload();
  }

  private async handleUnload(): Promise<void> {
    debugLog(t('plugin.unloadingMessage'));

    await this.persistTerminalViewsForUnload();

    // Clean up the feature visibility manager
    if (this.featureVisibilityManager) {
      this.featureVisibilityManager.cleanup();
    }

    this.closePresetScriptsMenu();

    // Clean up the terminal service (this automatically cleans up all terminal instances)
    if (this._terminalService) {
      try {
        debugLog('[TerminalPlugin] Shutting down TerminalService...');
        await this._terminalService.shutdown();
        debugLog('[TerminalPlugin] TerminalService stopped');
      } catch (error) {
        errorLog('[TerminalPlugin] Failed to shutdown TerminalService:', error);
      }
    }

    this._agentStatusService?.stop();
    this._agentStatusService = null;

    // Stop the server
    if (this._serverManager) {
      try {
        debugLog('[TerminalPlugin] Shutting down ServerManager...');
        await this._serverManager.shutdown();
        debugLog('[TerminalPlugin] ServerManager stopped');
      } catch (error) {
        errorLog('[TerminalPlugin] Failed to stop ServerManager:', error);
      }
    }

    debugLog(t('plugin.unloadedMessage'));
  }

  private async persistTerminalViewsForUnload(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
    await Promise.all(leaves.map(async (leaf) => {
      const view = leaf.view;
      if (view instanceof TerminalView) {
        await view.persistRestoreStateForUnload();
      }
    }));
  }


  /**
   * Load settings
   */
  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<TerminalSettings> | null;
    const normalizedPresetScripts = this.normalizePresetScripts(loaded?.presetScripts);
    this.settings = {
      ...DEFAULT_TERMINAL_SETTINGS,
      ...loaded,
      // Ensure the visibility config exists
      visibility: {
        ...DEFAULT_TERMINAL_SETTINGS.visibility,
        ...loaded?.visibility,
      },
      // Ensure the presetScripts config exists
      presetScripts: normalizedPresetScripts,
    };
  }

  /**
   * Save settings
   */
  async saveSettings() {
    this.settings.presetScripts = this.normalizePresetScripts(this.settings.presetScripts);
    await this.saveData(this.settings);
    
    // Update debug mode
    const { setDebugMode } = await import('./utils/logger');
    setDebugMode(this.settings.enableDebugLog);
    
    // Update the ServerManager configuration
    if (this._serverManager) {
      this._serverManager.updateDebugMode(this.settings.enableDebugLog);
    }

    // Update terminal service settings
    if (this._terminalService) {
      this._terminalService.updateSettings(this.settings);
    }
  }

  private normalizePresetScripts(value: unknown): PresetScript[] {
    // Drop preset scripts from features that are no longer shipped.
    const REMOVED_PRESET_SCRIPT_IDS = new Set(['claude-code', 'codex', 'opencode']);
    const scripts = (Array.isArray(value)
      ? value.map((script: PresetScript) => this.normalizePresetScript(script))
      : []
    ).filter((script) => !REMOVED_PRESET_SCRIPT_IDS.has(script.id));
    const existingIds = new Set(scripts.map((script) => script.id));

    // Seed missing built-in workflows. This happens on first install or if a
    // user has deleted a built-in workflow — it's a one-time recovery, not a
    // continuous "reset to defaults". Once seeded, the user's saved version
    // is the source of truth.
    for (const builtInScript of DEFAULT_PRESET_SCRIPTS) {
      if (existingIds.has(builtInScript.id)) {
        continue;
      }

      scripts.push(this.clonePresetScript(builtInScript));
      existingIds.add(builtInScript.id);
    }

    return scripts;
  }

  private clonePresetScript(script: PresetScript): PresetScript {
    return {
      ...script,
      actions: script.actions.map((action) => ({ ...action })),
    };
  }

  private registerFeatureVisibility(): void {
    this.featureVisibilityManager.registerFeature({
      id: 'terminal',
      getVisibility: () => this.settings.visibility,
      ribbon: {
        icon: TERMY_RIBBON_ICON_ID,
        tooltip: t('ribbon.terminalTooltip'),
        callback: () => {
          void this.activateTerminalView();
        },
      },
      onVisibilityChange: () => {
        // Update the terminal button in new tabs when terminal visibility settings change
        this.injectTerminalButtonToEmptyViews();
        // Update the status bar display
        this.updateStatusBar();
      },
    });
  }

  private registerCustomIcons(): void {
    addIcon(TERMY_RIBBON_ICON_ID, createTermyLogoSvgMarkup());
  }

  /**
   * Update feature visibility
   * Called after settings change
   */
  updateFeatureVisibility(): void {
    this.featureVisibilityManager.updateAllVisibility();
  }

  /**
   * Initialize the status bar
   */
  private initStatusBar(): void {
    this._statusBarItem = this.addStatusBarItem();
    this._statusBarItem.addClass('terminal-status-bar');
    this._statusBarItem.addClass('is-clickable');
    this._statusBarItem.setAttr('aria-label', t('ribbon.terminalTooltip'));

    // Create the SVG icon and label
    const iconEl = createTermyLogoSvg(18);
    iconEl.addClass('terminal-status-bar-icon');
    const labelEl = activeDocument.createElement('span');
    labelEl.addClass('terminal-status-bar-label');
    labelEl.textContent = 'Termy';
    this._statusBarItem.append(iconEl, labelEl);
    
    // Add click handler
    this._statusBarItem.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      this.togglePresetScriptsMenu(event);
    });
    
    // Context menu: preset scripts
    this._statusBarItem.addEventListener('contextmenu', (event: MouseEvent) => {
      event.preventDefault();
      this.togglePresetScriptsMenu(event);
    });
    
    // Show or hide based on settings
    this.updateStatusBar();
  }

  /**
   * Update the status bar visibility
   */
  private updateStatusBar(): void {
    if (!this._statusBarItem) return;
    
    const shouldShow = this.settings.visibility.enabled && 
                       this.settings.visibility.showInStatusBar;
    
    this._statusBarItem.toggleClass('is-hidden', !shouldShow);
  }

  /**
   * Activate the terminal view
   */
  async activateTerminalView(targetLeaf?: WorkspaceLeaf): Promise<void> {
    const { workspace } = this.app;

    // 复用已存在的单一 Termy 终端 view（单标签管理多终端）；不存在才新建
    if (!targetLeaf) {
      const existing = workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
      if (existing.length > 0) {
        void workspace.revealLeaf(existing[0]);
        workspace.setActiveLeaf(existing[0], { focus: true });
        this.focusTerminalLeaf(existing[0]);
        return;
      }
    }

    const leaf = targetLeaf ?? this.getLeafForNewTerminal();
    await leaf.setViewState({
      type: TERMINAL_VIEW_TYPE,
      active: true,
    });
    workspace.setActiveLeaf(leaf, { focus: true });
    this.focusTerminalLeaf(leaf);
  }


  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /**
   * Register all commands
   */
  private registerCommands(): void {
    // Open terminal
    this.addCommand({
      id: 'open-terminal',
      name: t('commands.openTerminal'),
      checkCallback: (checking: boolean) => {
        // Check visibility settings
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        if (!checking) {
          void this.activateTerminalView();
        }
        return true;
      }
    });

    this.addCommand({
      id: 'toggle-codex-activity-panel',
      name: t('commands.toggleCodexActivityPanel'),
      callback: () => {
        const terminalView = this.getActiveTerminalView();
        if (!terminalView) {
          return;
        }
        window.setTimeout(() => {
          if (this.app.workspace.getActiveViewOfType(TerminalView) !== terminalView) {
            this.app.workspace.setActiveLeaf(terminalView.leaf, { focus: true });
          }
          terminalView.toggleCodexActivityPanel();
        }, 0);
      },
    });

    // Clear screen
    this.addCommand({
      id: 'terminal-clear',
      name: t('commands.terminalClear'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        const terminalView = this.getActiveTerminalView();
        const terminal = terminalView?.getTerminalInstance();
        if (terminal) {
          if (!checking) {
            terminal.getXterm().clear();
          }
          return true;
        }
        return false;
      }
    });

    // Copy
    this.addCommand({
      id: 'terminal-copy',
      name: t('commands.terminalCopy'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        const terminalView = this.getActiveTerminalView();
        const terminal = terminalView?.getTerminalInstance();
        if (terminal && terminal.getXterm().hasSelection()) {
          if (!checking) {
            const selection = terminal.getXterm().getSelection();
            void navigator.clipboard.writeText(selection).catch((error) => {
              errorLog('[TerminalPlugin] Copy failed:', error);
            });
          }
          return true;
        }
        return false;
      }
    });

    // Paste
    this.addCommand({
      id: 'terminal-paste',
      name: t('commands.terminalPaste'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        const terminalView = this.getActiveTerminalView();
        const terminal = terminalView?.getTerminalInstance();
        if (terminal) {
          if (!checking) {
            void terminal.pasteFromClipboard().catch((error) => {
              errorLog('[TerminalPlugin] Paste failed:', error);
            });
          }
          return true;
        }
        return false;
      }
    });

    // Increase font size
    this.addCommand({
      id: 'terminal-font-increase',
      name: t('commands.terminalFontIncrease'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        const terminalView = this.getActiveTerminalView();
        const terminal = terminalView?.getTerminalInstance();
        if (terminal) {
          if (!checking) {
            terminal.increaseFontSize();
          }
          return true;
        }
        return false;
      }
    });

    // Decrease font size
    this.addCommand({
      id: 'terminal-font-decrease',
      name: t('commands.terminalFontDecrease'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        const terminalView = this.getActiveTerminalView();
        const terminal = terminalView?.getTerminalInstance();
        if (terminal) {
          if (!checking) {
            terminal.decreaseFontSize();
          }
          return true;
        }
        return false;
      }
    });

    // Reset font size
    this.addCommand({
      id: 'terminal-font-reset',
      name: t('commands.terminalFontReset'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        const terminalView = this.getActiveTerminalView();
        const terminal = terminalView?.getTerminalInstance();
        if (terminal) {
          if (!checking) {
            terminal.resetFontSize();
          }
          return true;
        }
        return false;
      }
    });

    // Register internal tab navigation commands. Focused terminal key handling
    // still happens in terminalInstance.matchTabNavKey.
    const addTabCommand = (
      id: string,
      name: string,
      run: (view: TerminalView) => void,
    ): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking: boolean) => {
          const terminalView = this.getActiveTerminalView();
          if (terminalView) {
            if (!checking) run(terminalView);
            return true;
          }
          return false;
        },
      });
    };

    addTabCommand('terminal-tab-new', '新建终端标签', (v) => v.openNewTab());
    addTabCommand('terminal-tab-close', '关闭当前标签', (v) => v.closeActiveTab());
    addTabCommand('terminal-tab-rename', '重命名当前标签', (v) => v.renameActiveTab());
    addTabCommand('terminal-tab-next', '下一个标签', (v) => v.nextTab());
    addTabCommand('terminal-tab-prev', '上一个标签', (v) => v.prevTab());
    for (let i = 1; i <= 9; i++) {
      addTabCommand(`terminal-tab-${i}`, `跳到第 ${i} 个标签`, (v) => v.gotoTab(i - 1));
    }
    addTabCommand('terminal-tab-10', '跳到第 10 个标签', (v) => v.gotoTab(9));

    // Clear buffer
    this.addCommand({
      id: 'terminal-clear-buffer',
      name: t('commands.terminalClearBuffer'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }
        const terminalView = this.getActiveTerminalView();
        const terminal = terminalView?.getTerminalInstance();
        if (terminal) {
          if (!checking) {
            terminal.clearBuffer();
          }
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: 'terminal-prompt-previous',
      name: t('commands.terminalPromptPrevious'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }

        if (!checking) {
          this.navigateTerminalPrompt('previous');
        }

        return true;
      }
    });

    this.addCommand({
      id: 'terminal-prompt-next',
      name: t('commands.terminalPromptNext'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }

        if (!checking) {
          this.navigateTerminalPrompt('next');
        }

        return true;
      }
    });

    this.addCommand({
      id: 'terminal-prompt-last-failed',
      name: t('commands.terminalPromptLastFailed'),
      checkCallback: (checking: boolean) => {
        if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
          return false;
        }

        if (!checking) {
          this.navigateToLastFailedTerminalCommand();
        }

        return true;
      }
    });
  }

  private registerPresetScriptCommands(): void {
    const scripts = this.settings.presetScripts ?? [];
    scripts.forEach((script) => {
      const commandId = this.getPresetScriptCommandId(script.id);
      if (this.registeredPresetScriptCommandIds.has(commandId)) return;

      this.registeredPresetScriptCommandIds.add(commandId);

      this.addCommand({
        id: commandId,
        name: `${t('commands.presetScriptPrefix')}${script.name || t('settingsDetails.terminal.presetScriptsUnnamed')}`,
        checkCallback: (checking: boolean) => {
          if (!this.featureVisibilityManager.isVisibleAt('terminal', 'showInCommandPalette')) {
            return false;
          }
          const currentScript = this.getPresetScriptById(script.id);
          if (!currentScript) return false;
          if (!(currentScript.showInStatusBar ?? true)) {
            return false;
          }
          if (!checking) {
            this.runPresetScriptSafely(currentScript);
          }
          return true;
        }
      });
    });
  }

  private runPresetScriptSafely(script: PresetScript): void {
    this.runPresetScript(script).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(t('notices.presetScript.runFailed', { message }));
    });
  }

  /**
   * Get the currently active terminal view
   */
  private getActiveTerminalView(): TerminalView | null {
    const activeView = this.app.workspace.getActiveViewOfType(TerminalView);
    
    // Prefer the currently active terminal view
    if (activeView) {
      return activeView;
    }
    
    // Otherwise return the first terminal view
    const leaves = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
    const view = leaves.map((item) => item.view).find((item) => this.isTerminalView(item));
    return view ?? null;
  }

  private getActiveTerminalInstance(): TerminalInstance | null {
    return this.getActiveTerminalView()?.getTerminalInstance() ?? null;
  }

  private focusTerminalView(terminalView: TerminalView, terminal: TerminalInstance): void {
    this.app.workspace.setActiveLeaf(terminalView.leaf, { focus: true });
    terminal.focus();
  }

  private navigateTerminalPrompt(direction: 'previous' | 'next'): void {
    const terminal = this.getActiveTerminalInstance();
    if (!terminal) {
      new Notice(t('notices.presetScript.terminalUnavailable'));
      return;
    }

    if (!terminal.navigatePrompt(direction)) {
      new Notice(t('notices.terminal.promptNavigationUnavailable'));
    }
  }

  private navigateToLastFailedTerminalCommand(): void {
    const terminal = this.getActiveTerminalInstance();
    if (!terminal) {
      new Notice(t('notices.presetScript.terminalUnavailable'));
      return;
    }

    if (!terminal.navigateToLastFailedCommand()) {
      new Notice(t('notices.terminal.failedCommandUnavailable'));
    }
  }

  private isTerminalView(view: View | null | undefined): view is TerminalView {
    return !!view && view.getViewType() === TERMINAL_VIEW_TYPE;
  }

  /**
   * Register the "Open terminal" action in new tabs
   * Inject a custom button into empty tabs by listening to the layout-change event
   */
  private registerNewTabTerminalAction(): void {
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.injectTerminalButtonToEmptyViews();
      })
    );

    // Initial injection
    this.injectTerminalButtonToEmptyViews();
  }

  private registerTerminalAutoFocus(): void {
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf) {
          this.focusTerminalLeaf(leaf);
        }
      })
    );
  }

  private focusTerminalLeaf(leaf: WorkspaceLeaf): void {
    const view = leaf.view;
    if (view instanceof TerminalView) {
      view.focusActiveTerminalSoon();
    }
  }

  /**
   * Inject the "Open terminal" button into all empty tabs
   * Inject or remove the button based on the showInNewTab setting
   */
  private injectTerminalButtonToEmptyViews(): void {
    const shouldShow = this.settings.visibility.enabled && 
                       this.settings.visibility.showInNewTab;
    
    // Find all empty views
    const emptyViews = activeDocument.querySelectorAll('.workspace-leaf-content[data-type="empty"] .view-content');
    
    emptyViews.forEach((emptyView) => {
      const existingButton = emptyView.querySelector('.terminal-plugin-terminal-action');
      
      if (!shouldShow) {
        // If it should not be shown, remove the existing button
        if (existingButton) {
          existingButton.remove();
        }
        return;
      }
      
      // Check whether it has already been injected
      if (existingButton) {
        return;
      }

      // Find the actions container
      const actionsContainer = emptyView.querySelector('.empty-state-action-list');
      if (!actionsContainer) {
        return;
      }

      // Create the "Open terminal" button
      const terminalAction = activeDocument.createElement('div');
      terminalAction.className = 'empty-state-action terminal-plugin-terminal-action';
      terminalAction.textContent = t('commands.openTerminal');
      terminalAction.addEventListener('click', () => {
        const leaf = this.findLeafByEmptyView(emptyView);
        void this.activateTerminalView(leaf ?? undefined);
      });

      // Add it to the actions list
      actionsContainer.appendChild(terminalAction);
    });
  }

  /**
   * Get the leaf to use for a new terminal
   */
  private getLeafForNewTerminal(): WorkspaceLeaf {
    return this.app.workspace.getLeaf('tab');
  }

  private getPresetScriptById(scriptId: string): PresetScript | null {
    const scripts = this.settings.presetScripts ?? [];
    return scripts.find(script => script.id === scriptId) ?? null;
  }

  private findLeafByEmptyView(emptyView: Element): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType('empty');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (this.hasContentEl(view) && view.contentEl === emptyView) {
        return leaf;
      }
    }
    return null;
  }

  private hasContentEl(view: unknown): view is { contentEl: Element } {
    return typeof view === 'object' && view !== null && 'contentEl' in view;
  }

  private getPresetScriptCommandId(scriptId: string): string {
    return `preset-script-${scriptId}`;
  }

  private createPresetScriptId(): string {
    const random = Math.random().toString(36).slice(2, 8);
    return `preset-${Date.now()}-${random}`;
  }

  private createWorkflowActionId(): string {
    const random = Math.random().toString(36).slice(2, 8);
    return `action-${Date.now()}-${random}`;
  }

  private normalizePresetScript(script: PresetScript): PresetScript {
    const sourceActions = Array.isArray(script.actions) ? script.actions : [];
    const actions = sourceActions
      .map((action) => this.normalizeWorkflowAction(action))
      .filter((action) => action.value.length > 0);

    const normalized: PresetScript = {
      id: (script.id || '').trim(),
      sourceTemplateId: typeof script.sourceTemplateId === 'string' && script.sourceTemplateId.trim().length > 0
        ? script.sourceTemplateId.trim()
        : undefined,
      name: (script.name || '').trim(),
      icon: (script.icon || '').trim(),
      actions,
      terminalTitle: (script.terminalTitle || '').trim(),
      showInStatusBar: script.showInStatusBar !== false,
      autoOpenTerminal: script.autoOpenTerminal !== false,
      runInNewTerminal: script.runInNewTerminal === true,
    };

    return normalized;
  }

  private normalizeWorkflowAction(action: PresetWorkflowAction): PresetWorkflowAction {
    const rawType = (action?.type || '').trim();
    const type = rawType === 'obsidian-command' || rawType === 'open-external'
      ? rawType
      : 'terminal-command';
    const value = (action?.value || '').trim();
    const id = (action?.id || '').trim() || this.createWorkflowActionId();
    const enabled = action?.enabled !== false;
    const note = typeof action?.note === 'string' ? action.note.trim() : '';
    return { id, type, value, enabled, note };
  }

  private openPresetScriptCreateModal(): void {
    const scripts = this.settings.presetScripts ?? [];
    let newId = this.createPresetScriptId();
    while (scripts.some(script => script.id === newId)) {
      newId = this.createPresetScriptId();
    }
    const newScript: PresetScript = {
      id: newId,
      name: '',
      icon: '',
      actions: [
        {
          id: this.createWorkflowActionId(),
          type: 'terminal-command',
          value: '',
          enabled: true,
          note: '',
        },
      ],
      terminalTitle: '',
      showInStatusBar: true,
      autoOpenTerminal: true,
      runInNewTerminal: false,
    };
    const modal = new PresetScriptModal(this.app, newScript, (updatedScript: PresetScript) => {
      scripts.push(updatedScript);
      this.settings.presetScripts = scripts;
      void this.saveSettings();
    }, true);
    modal.open();
  }

  private openPresetScriptEditModal(script: PresetScript): void {
    const clone = this.clonePresetScript(script);
    const modal = new PresetScriptModal(this.app, clone, (updatedScript: PresetScript) => {
      const scripts = this.settings.presetScripts ?? [];
      const index = scripts.findIndex(item => item.id === updatedScript.id);
      if (index >= 0) {
        scripts[index] = updatedScript;
      }
      this.settings.presetScripts = scripts;
      void this.saveSettings();
    }, false);
    modal.open();
  }

  private buildPresetScriptTooltip(script: PresetScript): string {
    const name = script.name?.trim() || t('settingsDetails.terminal.presetScriptsUnnamed');
    const actions = Array.isArray(script.actions) ? script.actions : [];
    const enabledActions = actions.filter((action) => action.enabled !== false);

    if (enabledActions.length === 0) {
      return name;
    }

    const lines = enabledActions.map((action) => {
      const prefix = action.type === 'obsidian-command'
        ? 'Obsidian'
        : action.type === 'open-external'
          ? 'URL'
          : 'Terminal';
      const value = (action.value ?? '').trim();
      return value ? `${prefix}: ${value}` : prefix;
    });

    return `${name}\n${lines.join('\n')}`;
  }

  private confirmAndDeletePresetScript(scriptId: string, scriptName: string): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText(t('common.confirm'));
    modal.contentEl.createEl('p', {
      text: t('settingsDetails.terminal.presetScriptsDeleteConfirm', { name: scriptName }),
    });
    const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttonContainer.createEl('button', { cls: 'mod-cancel', text: t('common.cancel') });
    cancelBtn.addEventListener('click', () => modal.close());
    const confirmBtn = buttonContainer.createEl('button', { cls: 'mod-cta', text: t('common.confirm') });
    confirmBtn.addEventListener('click', () => {
      modal.close();
      this.settings.presetScripts = (this.settings.presetScripts ?? []).filter(s => s.id !== scriptId);
      void this.saveSettings();
    });
    modal.open();
  }

  private togglePresetScriptsMenu(event: MouseEvent): void {
    if (this._presetScriptsMenuEl) {
      this.closePresetScriptsMenu();
      return;
    }
    // Kick off a background availability refresh — the menu still renders
    // immediately using the most recent snapshot; the badges update in place
    // once new probe results arrive.
    const anchorRect = this._statusBarItem?.getBoundingClientRect();
    if (anchorRect) {
      this.showPresetScriptsMenuAtRect(anchorRect);
    } else {
      this.showPresetScriptsMenuAtPoint(event.clientX, event.clientY);
    }
  }

  private showPresetScriptsMenuAtPoint(x: number, y: number): void {
    const menu = this.buildPresetScriptsMenu();
    if (!menu) return;
    menu.setCssStyles({ left: `${x}px`, top: `${y}px` });
    this.mountPresetScriptsMenu(menu);
    this.adjustPresetScriptsMenuPosition(menu);
  }

  private showPresetScriptsMenuAtRect(rect: DOMRect): void {
    const menu = this.buildPresetScriptsMenu();
    if (!menu) return;
    menu.setCssStyles({ left: `${rect.left}px`, top: `${rect.top}px` });
    this.mountPresetScriptsMenu(menu);
    const menuRect = menu.getBoundingClientRect();
    let top = rect.top - menuRect.height - 8;
    if (top < 8) {
      top = rect.bottom + 8;
    }
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 8) {
      left = window.innerWidth - menuRect.width - 8;
    }
    if (left < 8) left = 8;
    menu.setCssStyles({ top: `${top}px`, left: `${left}px` });
  }

  private mountPresetScriptsMenu(menu: HTMLElement): void {
    this.closePresetScriptsMenu();
    activeDocument.body.appendChild(menu);
    this._presetScriptsMenuEl = menu;

    const onOutsideClick = (event: MouseEvent) => {
      if (!menu.contains(event.target as Node)) {
        this.closePresetScriptsMenu();
      }
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.closePresetScriptsMenu();
      }
    };
    activeDocument.addEventListener('mousedown', onOutsideClick, true);
    activeDocument.addEventListener('keydown', onKeydown, true);
    this._presetScriptsMenuCleanup = () => {
      activeDocument.removeEventListener('mousedown', onOutsideClick, true);
      activeDocument.removeEventListener('keydown', onKeydown, true);
    };
  }

  private adjustPresetScriptsMenuPosition(menu: HTMLElement): void {
    const rect = menu.getBoundingClientRect();
    let left = rect.left;
    let top = rect.top;
    if (rect.right > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - rect.width - 8);
    }
    if (rect.bottom > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - rect.height - 8);
    }
    menu.setCssStyles({ left: `${left}px`, top: `${top}px` });
  }

  private buildPresetScriptsMenu(): HTMLElement | null {
    const scripts = (this.settings.presetScripts ?? [])
      .filter(script => script.showInStatusBar !== false);
    const activeDocument = this.app.workspace.containerEl.ownerDocument;
    const menu = activeDocument.createElement('div');
    menu.className = 'preset-scripts-menu';
    menu.setAttribute('role', 'menu');

    const listEl = activeDocument.createElement('div');
    listEl.className = 'preset-scripts-menu-list';

    if (scripts.length > 0) {
      this.appendRegularPresetMenuItems(listEl, scripts);
    } else {
      const empty = activeDocument.createElement('div');
      empty.className = 'preset-scripts-menu-item is-disabled';
      empty.textContent = t('settingsDetails.terminal.presetScriptsEmpty');
      listEl.appendChild(empty);
    }

    menu.appendChild(listEl);

    const footerEl = activeDocument.createElement('div');
    footerEl.className = 'preset-scripts-menu-footer';
    const addItem = activeDocument.createElement('button');
    addItem.type = 'button';
    addItem.className = 'preset-scripts-menu-item preset-scripts-menu-add';
    addItem.textContent = t('settingsDetails.terminal.presetScriptsAdd');
    addItem.addEventListener('click', () => {
      this.closePresetScriptsMenu();
      this.openPresetScriptCreateModal();
    });
    footerEl.appendChild(addItem);
    menu.appendChild(footerEl);

    return menu;
  }
  private appendRegularPresetMenuItems(
    listEl: HTMLElement,
    scripts: PresetScript[],
  ): void {
    let draggedItem: HTMLElement | null = null;
    let draggedScriptId: string | null = null;

    scripts.forEach((script) => {
      const item = activeDocument.createElement('div');
      item.className = 'preset-scripts-menu-item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('draggable', 'true');
      item.dataset.scriptId = script.id;

      const dragHandle = activeDocument.createElement('div');
      dragHandle.className = 'preset-scripts-menu-drag-handle';
      setIcon(dragHandle, 'grip-vertical');
      item.appendChild(dragHandle);

      const iconEl = activeDocument.createElement('div');
      iconEl.className = 'preset-scripts-menu-icon';
      renderPresetScriptIcon(iconEl, script.icon || 'terminal');
      item.appendChild(iconEl);

      const labelEl = activeDocument.createElement('div');
      labelEl.className = 'preset-scripts-menu-label';
      labelEl.textContent = script.name || t('settingsDetails.terminal.presetScriptsUnnamed');
      item.appendChild(labelEl);

      setTooltip(item, this.buildPresetScriptTooltip(script), {
        placement: 'top',
        classes: ['preset-script-tooltip'],
      });

      const actionsEl = activeDocument.createElement('div');
      actionsEl.className = 'preset-scripts-menu-actions';

      const editBtn = activeDocument.createElement('button');
      editBtn.className = 'preset-scripts-menu-action-btn';
      editBtn.setAttribute('aria-label', t('modals.presetScript.titleEdit'));
      setIcon(editBtn, 'pencil');
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closePresetScriptsMenu();
        this.openPresetScriptEditModal(script);
      });
      actionsEl.appendChild(editBtn);

      const isBuiltIn = DEFAULT_PRESET_SCRIPTS.some(d => d.id === script.id);
      if (!isBuiltIn) {
        const deleteBtn = activeDocument.createElement('button');
        deleteBtn.className = 'preset-scripts-menu-action-btn preset-scripts-menu-action-delete';
        deleteBtn.setAttribute('aria-label', t('common.delete'));
        setIcon(deleteBtn, 'trash');
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closePresetScriptsMenu();
          const scriptName = script.name?.trim() || t('settingsDetails.terminal.presetScriptsUnnamed');
          this.confirmAndDeletePresetScript(script.id, scriptName);
        });
        actionsEl.appendChild(deleteBtn);
      }
      item.appendChild(actionsEl);

      item.addEventListener('dragstart', (e) => {
        draggedItem = item;
        draggedScriptId = script.id;
        item.addClass('is-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', script.id);
        }
      });

      item.addEventListener('dragend', () => {
        if (draggedItem) {
          draggedItem.removeClass('is-dragging');
        }
        draggedItem = null;
        draggedScriptId = null;
        listEl.querySelectorAll('.preset-scripts-menu-item').forEach(el => {
          (el as HTMLElement).removeClass('drag-over-above');
          (el as HTMLElement).removeClass('drag-over-below');
        });
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!draggedItem || draggedScriptId === script.id) return;
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        listEl.querySelectorAll('.preset-scripts-menu-item').forEach(el => {
          (el as HTMLElement).removeClass('drag-over-above');
          (el as HTMLElement).removeClass('drag-over-below');
        });
        if (e.clientY < midY) {
          item.addClass('drag-over-above');
        } else {
          item.addClass('drag-over-below');
        }
      });

      item.addEventListener('dragleave', () => {
        item.removeClass('drag-over-above');
        item.removeClass('drag-over-below');
      });

      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.removeClass('drag-over-above');
        item.removeClass('drag-over-below');
        if (!draggedScriptId || draggedScriptId === script.id) return;

        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const insertBefore = e.clientY < midY;

        this.reorderPresetScript(draggedScriptId, script.id, insertBefore);
      });

      item.addEventListener('click', () => {
        this.closePresetScriptsMenu();
        this.runPresetScript(script).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          new Notice(t('notices.presetScript.runFailed', { message }));
        });
      });

      listEl.appendChild(item);
    });
  }

  private reorderPresetScript(draggedId: string, targetId: string, insertBefore: boolean): void {
    const scripts = [...(this.settings.presetScripts ?? [])];
    const draggedIndex = scripts.findIndex(s => s.id === draggedId);
    if (draggedIndex < 0) return;

    const [dragged] = scripts.splice(draggedIndex, 1);
    let targetIndex = scripts.findIndex(s => s.id === targetId);
    if (targetIndex < 0) {
      scripts.push(dragged);
    } else {
      if (!insertBefore) {
        targetIndex += 1;
      }
      scripts.splice(targetIndex, 0, dragged);
    }

    this.settings.presetScripts = scripts;
    void this.saveSettings();
    // Rebuild the menu to reflect new order
    this.closePresetScriptsMenu();
    const anchorRect = this._statusBarItem?.getBoundingClientRect();
    if (anchorRect) {
      this.showPresetScriptsMenuAtRect(anchorRect);
    }
  }

  private closePresetScriptsMenu(): void {
    if (this._presetScriptsMenuCleanup) {
      this._presetScriptsMenuCleanup();
      this._presetScriptsMenuCleanup = null;
    }
    if (this._presetScriptsMenuEl) {
      this._presetScriptsMenuEl.remove();
      this._presetScriptsMenuEl = null;
    }
  }

  private async runPresetScript(script: PresetScript): Promise<void> {
    if (!script) {
      new Notice(t('notices.presetScript.notFound'));
      return;
    }

    const normalizedScript = this.normalizePresetScript(script);
    const actions = normalizedScript.actions.filter((action) => action.enabled !== false);
    if (actions.length === 0) {
      new Notice(t('notices.presetScript.emptyCommand'));
      return;
    }

    this.runWorkflowNonTerminalActions(actions);

    const terminalCommand = this.buildWorkflowTerminalCommand(actions);
    if (!terminalCommand) {
      return;
    }

    let terminalView = this.getActiveTerminalView();
    if (normalizedScript.runInNewTerminal) {
      await this.activateTerminalView(this.getLeafForNewTerminal());
      terminalView = this.getActiveTerminalView();
    } else if (normalizedScript.autoOpenTerminal && !terminalView) {
      await this.activateTerminalView();
      terminalView = this.getActiveTerminalView();
    }

    if (!terminalView) {
      new Notice(t('notices.presetScript.terminalUnavailable'));
      return;
    }

    const terminal = await terminalView.waitForTerminalInstance();
    const title = (normalizedScript.terminalTitle || '').trim();
    if (title) {
      terminal.setTitle(title);
      this.updateLeafHeader(terminalView.leaf);
    }
    const normalizedCommand = this.normalizePresetScriptCommand(terminalCommand);
    terminal.write(normalizedCommand);
    this.focusTerminalView(terminalView, terminal);
  }

  private buildWorkflowTerminalCommand(actions: PresetWorkflowAction[]): string {
    return actions
      .filter((action) => action.type === 'terminal-command')
      .map((action) => action.value.trim())
      .filter((value) => value.length > 0)
      .join('\n');
  }

  private runWorkflowNonTerminalActions(actions: PresetWorkflowAction[]): void {
    const nonTerminalActions = actions.filter((action) => action.type !== 'terminal-command');
    for (const action of nonTerminalActions) {
      if (action.type === 'obsidian-command') {
        this.runObsidianCommandAction(action.value);
        continue;
      }
      if (action.type === 'open-external') {
        void this.runOpenExternalAction(action.value);
      }
    }
  }

  private runObsidianCommandAction(commandId: string): void {
    const normalizedCommandId = commandId.trim();
    if (!normalizedCommandId) {
      throw new Error('Workflow action "obsidian-command" requires command ID');
    }
    const openTerminalCommandId = `${this.manifest.id}:open-terminal`;
    if (normalizedCommandId === openTerminalCommandId || normalizedCommandId === 'open-terminal') {
      void this.activateTerminalView();
      return;
    }

    if (this.isTermyTerminalContextCommand(normalizedCommandId) && !this.getActiveTerminalView()) {
      void this.activateTerminalView();
    }

    const appWithCommands = this.app as typeof this.app & {
      commands?: {
        executeCommandById: (id: string) => boolean;
      };
    };
    if (!appWithCommands.commands) {
      throw new Error('Obsidian command manager is unavailable');
    }
    const executed = appWithCommands.commands.executeCommandById(normalizedCommandId);
    if (!executed) {
      throw new Error(`Obsidian command cannot execute in current context: ${normalizedCommandId}`);
    }
  }

  private isTermyTerminalContextCommand(commandId: string): boolean {
    const prefix = `${this.manifest.id}:terminal-`;
    return commandId.startsWith(prefix);
  }

  private async runOpenExternalAction(url: string): Promise<void> {
    const targetUrl = url.trim();
    if (!targetUrl) {
      throw new Error('Workflow action "open-external" requires a URL');
    }
    await shell.openExternal(targetUrl);
  }

  private normalizePresetScriptCommand(command: string): string {
    const normalized = command.replace(/\r?\n/g, '\r').trimEnd();
    return normalized.endsWith('\r') ? normalized : `${normalized}\r`;
  }

  private updateLeafHeader(leaf: WorkspaceLeaf): void {
    const leafWithHeader = leaf as WorkspaceLeaf & { updateHeader?: () => void };
    leafWithHeader.updateHeader?.();
  }

  /**
   * Get the absolute path to the plugin directory
   * 
   * @returns The absolute path to the plugin directory
   */
  getPluginDir(): string {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error('FileSystemAdapter is not available');
    }
    const vaultPath = normalizePath(adapter.getBasePath());
    const configDir = normalizePath(this.app.vault.configDir);
    const manifestDir = this.manifest.dir
      ? normalizePath(this.manifest.dir)
      : normalizePath(`${configDir}/plugins/${this.manifest.id}`);

    if (this.isAbsolutePath(manifestDir)) {
      return manifestDir;
    }

    return normalizePath(`${vaultPath}/${manifestDir}`);
  }

  private getVaultBasePath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return normalizePath(adapter.getBasePath());
    }
    return this.app.vault.getName();
  }

  private isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
  }
}

/**
 * Terminal view placeholder
 * Used to lazy-load the terminal view and avoid loading xterm.js at startup
 */
class TerminalViewPlaceholder extends TerminalView {
  private plugin: TerminalPlugin;
  private initialized = false;
  private initializing = false;

  constructor(leaf: WorkspaceLeaf, plugin: TerminalPlugin) {
    // Inject TerminalService lazily to avoid loading xterm.js at startup
    super(
      leaf,
      null,
      null,
      plugin.getTerminalRestoreStore(),
      false,
    );
    this.plugin = plugin;
  }

  async onOpen() {
    if (this.initialized || this.initializing) return;
    this.initializing = true;
    // Show the loading message
    this.contentEl.empty();
    this.contentEl.createEl('div', {
      text: t('terminal.loading'),
      cls: 'terminal-loading'
    });

    try {
      // Get the real services
      const [terminalService, agentStatusService] = await Promise.all([
        this.plugin.getTerminalService(),
        this.plugin.getAgentStatusService(),
      ]);

      this.setTerminalService(terminalService);
      this.setAgentStatusService(agentStatusService);

      // Clear the placeholder content and initialize the terminal view
      this.contentEl.empty();
      await super.onOpen();
      this.initialized = true;
    } catch (error) {
      errorLog('[TerminalViewPlaceholder] Failed to initialize:', error);
      this.contentEl.empty();
      this.contentEl.createEl('div', { 
        text: t('terminal.initFailed', { message: error instanceof Error ? error.message : String(error) }),
        cls: 'terminal-error'
      });
    } finally {
      this.initializing = false;
    }
  }

  async onClose() {
    await super.onClose();
  }
}
