/**
 * Terminal settings renderer
 * Responsible for rendering all terminal-related settings
 */

import type { App, ColorComponent, TextComponent } from 'obsidian';
import { Modal, Setting, Notice, Platform, ToggleComponent, setIcon } from 'obsidian';
import type { RendererContext } from '../types';
import type { PresetScript, ShellType } from '../settings';

import { 
  DEFAULT_PRESET_SCRIPTS,
  getCurrentPlatformShell, 
  setCurrentPlatformShell, 
  getCurrentPlatformCustomShellPath, 
  setCurrentPlatformCustomShellPath 
} from '../settings';
import { BaseSettingsRenderer } from './baseRenderer';
import { t } from '../../i18n';
import { PresetScriptModal } from '../../ui/terminal/presetScriptModal';
import { renderPresetScriptIcon } from '../../ui/terminal/presetScriptIcons';
import { getSelectableShellTypes } from '../../services/terminal/shellProfiles';
import { resolveBackendBinaryPath } from '../../services/server/serverManager';
import { clamp, normalizeBackgroundPosition, normalizeBackgroundSize, toCssUrl } from '../../utils/styleUtils';

const CURSOR_STYLES = ['block', 'underline', 'bar'] as const;
const BACKGROUND_IMAGE_SIZES = ['cover', 'contain', 'auto'] as const;
const PREFERRED_RENDERERS = ['canvas', 'webgl'] as const;

type CursorStyle = (typeof CURSOR_STYLES)[number];
type BackgroundImageSize = (typeof BACKGROUND_IMAGE_SIZES)[number];
type PreferredRenderer = (typeof PREFERRED_RENDERERS)[number];

const isCursorStyle = (value: string): value is CursorStyle =>
  CURSOR_STYLES.includes(value as CursorStyle);

const isBackgroundImageSize = (value: string): value is BackgroundImageSize =>
  BACKGROUND_IMAGE_SIZES.includes(value as BackgroundImageSize);

const isPreferredRenderer = (value: string): value is PreferredRenderer =>
  PREFERRED_RENDERERS.includes(value as PreferredRenderer);

type TerminalInstanceLike = {
  updateOptions: (options: { scrollback?: number }) => void;
  isAlive?: () => boolean;
  getCurrentRenderer?: () => 'canvas' | 'webgl';
  onRendererChange?: (callback: (renderer: 'canvas' | 'webgl') => void) => () => void;
};

interface DragState {
  row: HTMLElement | null;
  index: number | null;
}

type TerminalViewLike = {
  refreshAppearance?: () => void;
  getTerminalInstance?: () => TerminalInstanceLike | null;
  realView?: unknown;
};

const asTerminalViewLike = (value: unknown): TerminalViewLike | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as TerminalViewLike;
  if (typeof candidate.refreshAppearance === 'function') return candidate;
  if (typeof candidate.getTerminalInstance === 'function') return candidate;
  if (candidate.realView && candidate.realView !== value) return asTerminalViewLike(candidate.realView);
  return null;
};

class ConfirmModal extends Modal {
  private message: string;
  private onConfirm: () => void;
  private onCancel: () => void;

  constructor(app: App, message: string, onConfirm: () => void, onCancel: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    const titleEl = contentEl.createDiv({ cls: 'modal-title' });
    titleEl.createDiv({ cls: 'modal-title-text', text: t('common.confirm') });

    contentEl.createEl('p', { text: this.message });

    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
    const cancelBtn = buttonContainer.createEl('button', {
      cls: 'mod-cancel',
      text: t('common.cancel')
    });
    cancelBtn.addEventListener('click', () => {
      this.onCancel();
      this.close();
    });

    const confirmBtn = buttonContainer.createEl('button', {
      cls: 'mod-cta',
      text: t('common.confirm')
    });
    confirmBtn.addEventListener('click', () => {
      this.onConfirm();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const confirmAction = (app: App, message: string): Promise<boolean> =>
  new Promise((resolve) => {
    const modal = new ConfirmModal(
      app,
      message,
      () => resolve(true),
      () => resolve(false)
    );
    modal.open();
  });

/**
 * Validate whether the Shell path is valid (desktop only)
 * @param path Path to the Shell executable
 * @returns Whether the path exists and is valid
 */
function validateShellPath(path: string): boolean {
  if (!path || path.trim() === '') return false;
  // Mobile does not support filesystem checks
  if (Platform.isMobile) return true;
  try {
    const fs = window.require('fs') as typeof import('fs');
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Terminal settings renderer
 * Handles rendering for Shell program, instance behavior, theme, and appearance settings
 */
export class TerminalSettingsRenderer extends BaseSettingsRenderer {
  private themePreviewEl: HTMLElement | null = null;
  private themePreviewContentEl: HTMLElement | null = null;
  private themePreviewCursorEl: HTMLElement | null = null;
  private rendererStatusEl: HTMLElement | null = null;
  private displayActiveTab: 'theme' | 'appearance' = 'theme';
  private rendererChangeUnsubscribers: Array<() => void> = [];
  /**
   * Listeners registered against the plugin's launcher snapshot stream.
   * The render() entry tears them down before rebuilding the DOM so we
   * never accumulate listeners across re-renders.
   */
  private readonly builtInPresetIds = new Set(['claude-code', 'codex', 'opencode']);
  /**
   * Refresh hook for the "AI launcher update check is suppressed by
   * offline mode" hint. Set when the preset-scripts card mounts; called
   * from the server-connection card whenever offline mode toggles.
   * Null between renders.
   */

  /**
   * Render terminal settings
   * @param context Renderer context
   */
  render(context: RendererContext): void {
    // Tear down any subscriptions from a previous render before rebuilding the DOM.
    this.disposeRendererChangeSubscriptions();
    this.disposeLauncherSnapshotSubscriptions();
    this.context = context;
    const containerEl = context.containerEl;

    // Shell program settings card
    this.renderShellSettings(containerEl);

    // Instance behavior settings card

    // Display settings card (unified theme + appearance)
    this.renderDisplaySettings(containerEl);

    // Behavior settings card
    this.renderBehaviorSettings(containerEl);

    // Backend binary status + install card
    this.renderBackendSettings(containerEl);

    // Feature visibility settings card
    this.renderVisibilitySettings(containerEl);
  }

  /**
   * Render backend (termy-server) status + install instructions.
   *
   * 后端二进制不随 vault 同步，多机/新机器场景下需各自安装。此卡片显示当前探测到的
   * 二进制路径/状态，并给出 Homebrew 安装命令。
   */
  private renderBackendSettings(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: 'settings-card' });
    new Setting(card).setName(t('settingsDetails.terminal.backendSettings')).setHeading();

    const INSTALL_CMD = 'brew install pku-zhb/termy/termy-server';

    const statusSetting = new Setting(card).setName(t('settingsDetails.terminal.backendStatus'));
    const renderStatus = (): void => {
      const info = resolveBackendBinaryPath();
      statusSetting.setDesc(info.exists
        ? t('settingsDetails.terminal.backendStatusFound', { path: info.path })
        : t('settingsDetails.terminal.backendStatusMissing'));
    };
    renderStatus();
    statusSetting.addButton((btn) => btn
      .setButtonText(t('settingsDetails.terminal.backendRecheck'))
      .onClick(() => renderStatus()));

    new Setting(card)
      .setName(t('settingsDetails.terminal.backendInstall'))
      .setDesc(createFragment((frag) => {
        frag.appendText(t('settingsDetails.terminal.backendInstallDesc'));
        frag.createEl('br');
        frag.createEl('code', { text: INSTALL_CMD });
      }))
      .addButton((btn) => btn
        .setButtonText(t('settingsDetails.terminal.backendCopyCommand'))
        .setCta()
        .onClick(() => {
          void navigator.clipboard.writeText(INSTALL_CMD);
          new Notice(t('notices.settings.backendCommandCopied'));
        }));
  }

  /**
   * Render Shell program settings
   */
  private renderShellSettings(containerEl: HTMLElement): void {
    const shellCard = containerEl.createDiv({ cls: 'settings-card' });

    new Setting(shellCard)
      .setName(t('settingsDetails.terminal.shellSettings'))
      .setHeading();

    // Default Shell program selection
    const currentShell = getCurrentPlatformShell(this.context.plugin.settings);
    
    const shellDropdownSetting = new Setting(shellCard)
      .setName(t('settingsDetails.terminal.defaultShell'))
      .setDesc(t('settingsDetails.terminal.defaultShellDesc'))
      .addDropdown(dropdown => {
        for (const shellType of getSelectableShellTypes(currentShell)) {
          dropdown.addOption(shellType, t(`shellOptions.${shellType}`));
        }

        dropdown.setValue(currentShell);
        dropdown.onChange((value) => {
          setCurrentPlatformShell(this.context.plugin.settings, value as ShellType);
          void this.saveSettings();
          
          // Use a partial update instead of a full refresh
          this.toggleConditionalSection(
            shellCard,
            'custom-shell-path',
            value === 'custom',
            (el) => this.renderCustomShellPathSetting(el),
            shellDropdownSetting.settingEl
          );
        });
      });

    // Custom program path (shown only when custom is selected) - initial render
    this.toggleConditionalSection(
      shellCard,
      'custom-shell-path',
      currentShell === 'custom',
      (el) => this.renderCustomShellPathSetting(el),
      shellDropdownSetting.settingEl
    );

    // Default launch arguments
    new Setting(shellCard)
      .setName(t('settingsDetails.terminal.defaultArgs'))
      .setDesc(t('settingsDetails.terminal.defaultArgsDesc'))
      .addText(text => text
        .setPlaceholder(t('settingsDetails.terminal.defaultArgsPlaceholder'))
        .setValue(this.context.plugin.settings.shellArgs.join(' '))
        .onChange((value) => {
          // Split the string into an array and filter out empty entries
          this.context.plugin.settings.shellArgs = value
            .split(' ')
            .filter(arg => arg.trim().length > 0);
          void this.saveSettings();
        }));

    // Automatically enter the vault directory
    new Setting(shellCard)
      .setName(t('settingsDetails.terminal.autoEnterVault'))
      .setDesc(t('settingsDetails.terminal.autoEnterVaultDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.autoEnterVaultDirectory)
        .onChange((value) => {
          this.context.plugin.settings.autoEnterVaultDirectory = value;
          void this.saveSettings();
        }));
  }

  /**
   * Render the custom Shell path setting
   * Extracted into a separate method for toggleConditionalSection
   */
  private renderCustomShellPathSetting(container: HTMLElement): void {
    const currentCustomPath = getCurrentPlatformCustomShellPath(this.context.plugin.settings);
    
    new Setting(container)
      .setName(t('settingsDetails.terminal.customShellPath'))
      .setDesc(t('settingsDetails.terminal.customShellPathDesc'))
      .addText(text => {
        text
          .setPlaceholder(t('settingsDetails.terminal.customShellPathPlaceholder'))
          .setValue(currentCustomPath)
          .onChange((value) => {
            setCurrentPlatformCustomShellPath(this.context.plugin.settings, value);
            void this.saveSettings();
            
            // Validate the path
            this.validateCustomShellPath(container, value);
          });
        
        // Initial validation
        window.setTimeout(() => {
          this.validateCustomShellPath(container, currentCustomPath);
        }, 0);
        
        return text;
      });
  }


  /**
   * Render unified display settings (preview + theme/appearance tabs)
   */
  private renderDisplaySettings(containerEl: HTMLElement): void {
    const displayCard = containerEl.createDiv({ cls: 'settings-card' });

    new Setting(displayCard)
      .setName(t('settingsDetails.terminal.displaySettings'))
      .setHeading();

    // Persistent preview area (always visible regardless of active tab)
    this.renderThemePreview(displayCard);

    // Tab switcher
    const tabBar = displayCard.createDiv({ cls: 'terminal-display-tabs' });
    const themeTabBtn = tabBar.createEl('button', {
      cls: 'terminal-display-tab',
      text: t('settingsDetails.terminal.displayTabTheme'),
    });
    const appearanceTabBtn = tabBar.createEl('button', {
      cls: 'terminal-display-tab',
      text: t('settingsDetails.terminal.displayTabAppearance'),
    });

    // Tab content container
    const tabContent = displayCard.createDiv({ cls: 'terminal-display-tab-content' });

    const renderActiveTab = (): void => {
      tabContent.empty();
      themeTabBtn.toggleClass('is-active', this.displayActiveTab === 'theme');
      appearanceTabBtn.toggleClass('is-active', this.displayActiveTab === 'appearance');
      themeTabBtn.setAttribute('aria-pressed', String(this.displayActiveTab === 'theme'));
      appearanceTabBtn.setAttribute('aria-pressed', String(this.displayActiveTab === 'appearance'));

      if (this.displayActiveTab === 'theme') {
        this.renderThemeTabContent(tabContent);
      } else {
        this.renderAppearanceTabContent(tabContent);
      }
    };

    themeTabBtn.addEventListener('click', () => {
      if (this.displayActiveTab === 'theme') return;
      this.displayActiveTab = 'theme';
      renderActiveTab();
    });
    appearanceTabBtn.addEventListener('click', () => {
      if (this.displayActiveTab === 'appearance') return;
      this.displayActiveTab = 'appearance';
      renderActiveTab();
    });

    renderActiveTab();
  }

  /**
   * Render theme tab content (Obsidian theme toggle + custom color settings)
   */
  private renderThemeTabContent(container: HTMLElement): void {
    // Use the Obsidian theme
    const useObsidianThemeSetting = new Setting(container)
      .setName(t('settingsDetails.terminal.useObsidianTheme'))
      .setDesc(t('settingsDetails.terminal.useObsidianThemeDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.useObsidianTheme)
        .onChange((value) => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.useObsidianTheme = value;
          }).then(() => {
            this.updateCustomColorSettingsVisibility(container, useObsidianThemeSetting.settingEl);
          });
        }));

    this.updateCustomColorSettingsVisibility(container, useObsidianThemeSetting.settingEl);
  }

  /**
   * Render appearance tab content (font + cursor + renderer)
   */
  private renderAppearanceTabContent(container: HTMLElement): void {
    // Font size
    new Setting(container)
      .setName(t('settingsDetails.terminal.fontSize'))
      .setDesc(t('settingsDetails.terminal.fontSizeDesc'))
      .addSlider(slider => slider
        .setLimits(8, 24, 1)
        .setValue(this.context.plugin.settings.fontSize)
        .setDynamicTooltip()
        .onChange((value) => {
          void this.updateAppearanceSetting(() => {
            this.context.plugin.settings.fontSize = value;
          });
        }));

    // Font family
    new Setting(container)
      .setName(t('settingsDetails.terminal.fontFamily'))
      .setDesc(t('settingsDetails.terminal.fontFamilyDesc'))
      .addText(text => text
        .setPlaceholder(t('settingsDetails.terminal.fontFamilyPlaceholder'))
        .setValue(this.context.plugin.settings.fontFamily)
        .onChange((value) => {
          void this.updateAppearanceSetting(() => {
            this.context.plugin.settings.fontFamily = value;
          });
        }));

    // Cursor style
    new Setting(container)
      .setName(t('settingsDetails.terminal.cursorStyle'))
      .setDesc(t('settingsDetails.terminal.cursorStyleDesc'))
      .addDropdown(dropdown => {
        dropdown.addOption('block', t('cursorStyleOptions.block'));
        dropdown.addOption('underline', t('cursorStyleOptions.underline'));
        dropdown.addOption('bar', t('cursorStyleOptions.bar'));

        dropdown.setValue(this.context.plugin.settings.cursorStyle);
        dropdown.onChange((value) => {
          if (!isCursorStyle(value)) return;
          void this.updateAppearanceSetting(() => {
            this.context.plugin.settings.cursorStyle = value;
          });
        });
      });

    // Cursor blink
    new Setting(container)
      .setName(t('settingsDetails.terminal.cursorBlink'))
      .setDesc(t('settingsDetails.terminal.cursorBlinkDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.cursorBlink)
        .onChange((value) => {
          void this.updateAppearanceSetting(() => {
            this.context.plugin.settings.cursorBlink = value;
          });
        }));

    // Renderer type
    new Setting(container)
      .setName(t('settingsDetails.terminal.rendererType'))
      .setDesc(t('settingsDetails.terminal.rendererTypeDesc'))
      .addDropdown(dropdown => dropdown
        .addOption('canvas', t('rendererOptions.canvas'))
        .addOption('webgl', t('rendererOptions.webgl'))
        .setValue(this.context.plugin.settings.preferredRenderer)
        .onChange((value) => {
          if (!isPreferredRenderer(value)) {
            return;
          }
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.preferredRenderer = value;
          }).then(() => {
            this.updateBackgroundImageSettingsVisibility();
            new Notice(t('notices.settings.rendererUpdated'));
          });
        }));
  }

  /**
   * Render preset scripts settings
   */
  private renderPresetScriptsSettings(containerEl: HTMLElement): void {
    const scriptCard = containerEl.createDiv({ cls: 'settings-card' });

    const headerEl = scriptCard.createDiv({ cls: 'preset-scripts-header' });
    const headerText = headerEl.createDiv({ cls: 'preset-scripts-header-text' });
    headerText.createDiv({
      cls: 'preset-scripts-title',
      text: t('settingsDetails.terminal.presetScripts')
    });
    headerText.createDiv({
      cls: 'preset-scripts-desc',
      text: t('settingsDetails.terminal.presetScriptsDesc')
    });

    const headerActions = headerEl.createDiv({ cls: 'preset-scripts-header-actions' });
    const addBtn = headerActions.createEl('button', { cls: 'preset-scripts-add-btn' });
    addBtn.textContent = t('settingsDetails.terminal.presetScriptsAdd');
    addBtn.addEventListener('click', () => {
          const newScript: PresetScript = {
            id: this.createPresetScriptId(),
            name: '',
            icon: '',
            actions: [
              {
                id: this.createPresetActionId(),
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
      this.openPresetScriptModal(newScript, true, listEl);
    });

    const listEl = scriptCard.createDiv({ cls: 'preset-scripts-list' });
    this.renderPresetScriptsList(listEl);
  }

  private renderPresetScriptsList(listEl: HTMLElement): void {
    listEl.empty();

    const scripts = this.context.plugin.settings.presetScripts ?? [];
    if (scripts.length === 0) {
      const empty = listEl.createDiv({ cls: 'preset-scripts-empty' });
      empty.textContent = t('settingsDetails.terminal.presetScriptsEmpty');
      return;
    }

    const dragState: DragState = { row: null, index: null };
    scripts.forEach((script, index) => {
      this.renderPresetScriptRow(listEl, script, index, dragState);
    });
  }


  private renderPresetScriptRow(
    listEl: HTMLElement,
    script: PresetScript,
    index: number,
    dragState: DragState,
  ): void {
    const scripts = this.context.plugin.settings.presetScripts ?? [];
    const row = listEl.createDiv({ cls: 'preset-script-row' });
    row.setAttribute('draggable', 'true');
    row.dataset.index = String(index);

    const isBuiltIn = this.isBuiltInPresetScript(script);

    const dragHandle = row.createDiv({ cls: 'preset-script-drag-handle' });
    setIcon(dragHandle, 'grip-vertical');

    const toggleWrap = row.createDiv({ cls: 'preset-script-toggle' });
    const showInStatusBar = script.showInStatusBar ?? true;
    row.toggleClass('is-disabled', !showInStatusBar);
    const toggle = new ToggleComponent(toggleWrap);
    toggle.setValue(showInStatusBar);
    toggle.toggleEl.setAttribute('aria-label', t('settingsDetails.terminal.presetScriptShowInStatusBar'));
    toggle.onChange((value) => {
      script.showInStatusBar = value;
      row.toggleClass('is-disabled', !value);
      void this.saveSettings();
    });

    const iconEl = row.createDiv({ cls: 'preset-script-icon' });
    renderPresetScriptIcon(iconEl, script.icon || 'terminal');

    const contentEl = row.createDiv({ cls: 'preset-script-content' });
    const nameRowEl = contentEl.createDiv({ cls: 'preset-script-name-row' });
    nameRowEl.createDiv({
      cls: 'preset-script-name',
      text: script.name?.trim() || t('settingsDetails.terminal.presetScriptsUnnamed')
    });
    const actionsEl = row.createDiv({ cls: 'preset-script-actions' });
    const editBtn = actionsEl.createEl('button', { cls: 'clickable-icon' });
    setIcon(editBtn, 'pencil');
    editBtn.setAttribute('aria-label', t('modals.presetScript.titleEdit'));
    editBtn.addEventListener('click', () => {
      this.openPresetScriptModal(this.clonePresetScript(script), false, listEl);
    });

    if (isBuiltIn) {
      const resetBtn = actionsEl.createEl('button', { cls: 'clickable-icon preset-script-reset' });
      setIcon(resetBtn, 'reset');
      resetBtn.setAttribute('aria-label', t('common.reset'));
      resetBtn.addEventListener('click', () => {
        const scriptName = script.name?.trim() || t('settingsDetails.terminal.presetScriptsUnnamed');
        void this.confirmPresetScriptReset(scriptName).then((confirmed) => {
          if (!confirmed) return;
          void this.resetBuiltInPresetScript(listEl, script.id);
        });
      });
    } else {
      const deleteBtn = actionsEl.createEl('button', { cls: 'clickable-icon preset-script-delete' });
      setIcon(deleteBtn, 'trash');
      deleteBtn.setAttribute('aria-label', t('common.delete'));
      deleteBtn.addEventListener('click', () => {
        const scriptName = script.name?.trim() || t('settingsDetails.terminal.presetScriptsUnnamed');
        void this.confirmPresetScriptDelete(scriptName).then((confirmed) => {
          if (!confirmed) return;

          this.context.plugin.settings.presetScripts = scripts.filter(item => item.id !== script.id);
          void this.saveSettings().then(() => {
            this.renderPresetScriptsList(listEl);
          });
        });
      });
    }

    row.addEventListener('dragstart', (e) => {
      dragState.row = row;
      dragState.index = index;
      row.addClass('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
      }
    });

    row.addEventListener('dragend', () => {
      if (dragState.row) {
        dragState.row.removeClass('is-dragging');
      }
      dragState.row = null;
      dragState.index = null;
      listEl.querySelectorAll('.preset-script-row').forEach(el => {
        (el as HTMLElement).removeClass('drag-over-above');
        (el as HTMLElement).removeClass('drag-over-below');
      });
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (dragState.index === null || dragState.index === index) return;
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'move';
      }
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      listEl.querySelectorAll('.preset-script-row').forEach(el => {
        (el as HTMLElement).removeClass('drag-over-above');
        (el as HTMLElement).removeClass('drag-over-below');
      });
      if (e.clientY < midY) {
        row.addClass('drag-over-above');
      } else {
        row.addClass('drag-over-below');
      }
    });

    row.addEventListener('dragleave', () => {
      row.removeClass('drag-over-above');
      row.removeClass('drag-over-below');
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.removeClass('drag-over-above');
      row.removeClass('drag-over-below');
      if (dragState.index === null || dragState.index === index) return;

      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      let targetIndex = index;
      const draggedIndex = dragState.index;
      if (e.clientY >= midY && draggedIndex < index) {
        targetIndex = index;
      } else if (e.clientY >= midY && draggedIndex > index) {
        targetIndex = index + 1;
      } else if (e.clientY < midY && draggedIndex < index) {
        targetIndex = index - 1;
      } else {
        targetIndex = index;
      }

      void this.movePresetScript(listEl, draggedIndex, targetIndex);
    });
  }

  private isBuiltInPresetScript(script: PresetScript): boolean {
    return this.builtInPresetIds.has(script.id);
  }

  private clonePresetScript(script: PresetScript): PresetScript {
    return {
      ...script,
      actions: script.actions.map((action) => ({ ...action })),
    };
  }

  private createPresetScriptId(): string {
    const existingIds = new Set((this.context.plugin.settings.presetScripts ?? []).map((script) => script.id));
    let index = 1;
    let id = `custom-${Date.now().toString(36)}`;
    while (existingIds.has(id)) {
      id = `custom-${Date.now().toString(36)}-${index}`;
      index += 1;
    }
    return id;
  }

  private createPresetActionId(): string {
    return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private openPresetScriptModal(script: PresetScript, isNew: boolean, listEl: HTMLElement): void {
    const modal = new PresetScriptModal(this.context.app, script, (updatedScript: PresetScript) => {
      const scripts = [...(this.context.plugin.settings.presetScripts ?? [])];
      if (isNew) {
        scripts.push(updatedScript);
      } else {
        const index = scripts.findIndex((item) => item.id === updatedScript.id);
        if (index >= 0) {
          scripts[index] = updatedScript;
        }
      }

      this.context.plugin.settings.presetScripts = scripts;
      void this.saveSettings().then(() => {
        this.renderPresetScriptsList(listEl);
      });
    }, isNew);
    modal.open();
  }

  private async deletePresetScript(listEl: HTMLElement, scriptId: string): Promise<void> {
    this.context.plugin.settings.presetScripts = (this.context.plugin.settings.presetScripts ?? [])
      .filter((script) => script.id !== scriptId);
    await this.saveSettings();
    this.renderPresetScriptsList(listEl);
  }

  private async resetBuiltInPresetScript(listEl: HTMLElement, scriptId: string): Promise<void> {
    const defaultScript = DEFAULT_PRESET_SCRIPTS.find((script) => script.id === scriptId);
    if (!defaultScript) return;

    this.context.plugin.settings.presetScripts = (this.context.plugin.settings.presetScripts ?? [])
      .map((script) => script.id === scriptId ? this.clonePresetScript(defaultScript) : script);
    await this.saveSettings();
    this.renderPresetScriptsList(listEl);
  }

  private async movePresetScript(listEl: HTMLElement, fromIndex: number, toIndex: number): Promise<void> {
    const scripts = [...(this.context.plugin.settings.presetScripts ?? [])];
    if (
      fromIndex < 0
      || fromIndex >= scripts.length
      || toIndex < 0
      || toIndex >= scripts.length
      || fromIndex === toIndex
    ) {
      return;
    }

    const [script] = scripts.splice(fromIndex, 1);
    if (!script) return;
    scripts.splice(toIndex, 0, script);
    this.context.plugin.settings.presetScripts = scripts;
    await this.saveSettings();
    this.renderPresetScriptsList(listEl);
  }

  private getPresetScriptCommandPreview(script: PresetScript): string {
    const actions = Array.isArray(script.actions) ? script.actions : [];
    const enabledActions = actions.filter((action) => action.enabled !== false);
    if (actions.length === 0) {
      return t('settingsDetails.terminal.presetScriptsEmptyCommand');
    }

    if (enabledActions.length === 0) {
      return t('settingsDetails.terminal.presetScriptsNoEnabledActions');
    }

    const first = enabledActions[0];
    const prefix = first.type === 'obsidian-command'
      ? 'Obsidian'
      : first.type === 'open-external'
        ? 'URL'
        : 'Terminal';
    const normalized = first.value.trim().replace(/\r?\n/g, ' \\n ');
    const suffix = enabledActions.length > 1 ? ` (+${enabledActions.length - 1})` : '';
    const preview = `${prefix}: ${normalized}${suffix}`;
    if (!normalized) {
      return t('settingsDetails.terminal.presetScriptsEmptyCommand');
    }
    return preview.length > 160 ? `${preview.slice(0, 157)}...` : preview;
  }

  /**
   * Render custom color settings content
   * Extracted into a separate method for toggleConditionalSection
   */
  private renderCustomColorSettingsContent(container: HTMLElement): void {
    let backgroundColorPicker: ColorComponent | null = null;
    let foregroundColorPicker: ColorComponent | null = null;

    // Background color
    new Setting(container)
      .setName(t('settingsDetails.terminal.backgroundColor'))
      .setDesc(t('settingsDetails.terminal.backgroundColorDesc'))
      .addColorPicker(color => {
        backgroundColorPicker = color;
        return color
          .setValue(this.context.plugin.settings.backgroundColor || '#000000')
          .onChange((value) => {
            void this.updateThemeSetting(() => {
              this.context.plugin.settings.backgroundColor = value;
            });
          });
      })
      .addExtraButton(button => button
        .setIcon('reset')
        .setTooltip(t('common.reset'))
        .onClick(() => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.backgroundColor = undefined;
          }).then(() => {
            backgroundColorPicker?.setValue('#000000');
            new Notice(t('notices.settings.backgroundColorReset'));
          });
        }));

    // Foreground color
    new Setting(container)
      .setName(t('settingsDetails.terminal.foregroundColor'))
      .setDesc(t('settingsDetails.terminal.foregroundColorDesc'))
      .addColorPicker(color => {
        foregroundColorPicker = color;
        return color
          .setValue(this.context.plugin.settings.foregroundColor || '#FFFFFF')
          .onChange((value) => {
            void this.updateThemeSetting(() => {
              this.context.plugin.settings.foregroundColor = value;
            });
          });
      })
      .addExtraButton(button => button
        .setIcon('reset')
        .setTooltip(t('common.reset'))
        .onClick(() => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.foregroundColor = undefined;
          }).then(() => {
            foregroundColorPicker?.setValue('#FFFFFF');
            new Notice(t('notices.settings.foregroundColorReset'));
          });
        }));

    // Background image settings (WebGL mode silently ignores the background image)
    this.renderBackgroundImageSettings(container);
  }

  /**
   * Render background image settings
   */
  private renderBackgroundImageSettings(container: HTMLElement): void {
    const bgImageSetting = new Setting(container)
      .setName(t('settingsDetails.terminal.backgroundImage'))
      .setDesc(t('settingsDetails.terminal.backgroundImageDesc'));
    bgImageSetting.settingEl.addClass('terminal-background-image-setting');

    this.toggleConditionalSection(
      container,
      'background-image-webgl-hint',
      this.context.plugin.settings.preferredRenderer === 'webgl',
      (el) => {
        el.addClass('terminal-background-image-webgl-hint');
        el.createDiv({
          cls: 'setting-item-description',
          text: t('settingsDetails.terminal.backgroundImageWebglHint'),
        });
      },
      bgImageSetting.settingEl
    );

    let backgroundImageInput: TextComponent | null = null;

    bgImageSetting.addText(text => {
      backgroundImageInput = text;
      const inputEl = text
        .setPlaceholder(t('settingsDetails.terminal.backgroundImagePlaceholder'))
        .setValue(this.context.plugin.settings.backgroundImage || '')
        .onChange((value) => {
          this.context.plugin.settings.backgroundImage = value.trim() || undefined;
          this.updateThemePreview();
        });
      
      // Use a partial update on blur
      text.inputEl.addEventListener('blur', () => {
        void this.updateThemeSetting(() => {
          this.context.plugin.settings.backgroundImage = text.inputEl.value.trim() || undefined;
        }).then(() => {
          const hasImage = !!this.context.plugin.settings.backgroundImage;
          this.toggleConditionalSection(
            container,
            'background-image-options',
            hasImage,
            (el) => this.renderBackgroundImageOptionsContent(el),
            bgImageSetting.settingEl
          );
        });
      });
      
      return inputEl;
    });
    
    bgImageSetting.addExtraButton(button => button
      .setIcon('reset')
      .setTooltip(t('common.reset'))
      .onClick(() => {
        void this.updateThemeSetting(() => {
          this.context.plugin.settings.backgroundImage = undefined;
        }).then(() => {
          backgroundImageInput?.setValue('');
          
          // Use a partial update to remove background image options
          this.toggleConditionalSection(
            container,
            'background-image-options',
            false,
            (el) => this.renderBackgroundImageOptionsContent(el),
            bgImageSetting.settingEl
          );
          
          new Notice(t('notices.settings.backgroundImageCleared'));
        });
      }));

    // Background image-related options (shown only when a background image exists) - initial render
    this.toggleConditionalSection(
      container,
      'background-image-options',
      !!this.context.plugin.settings.backgroundImage,
      (el) => this.renderBackgroundImageOptionsContent(el),
      bgImageSetting.settingEl
    );
  }

  /**
   * Render background image-related options content
   * Extracted into a separate method for toggleConditionalSection
   */
  private renderBackgroundImageOptionsContent(container: HTMLElement): void {
    // Background image opacity
    new Setting(container)
      .setName(t('settingsDetails.terminal.backgroundImageOpacity'))
      .setDesc(t('settingsDetails.terminal.backgroundImageOpacityDesc'))
      .addSlider(slider => slider
        .setLimits(0, 1, 0.05)
        .setValue(this.context.plugin.settings.backgroundImageOpacity ?? 0.5)
        .setDynamicTooltip()
        .onChange((value) => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.backgroundImageOpacity = value;
          });
        }));

    // Background image size
    new Setting(container)
      .setName(t('settingsDetails.terminal.backgroundImageSize'))
      .setDesc(t('settingsDetails.terminal.backgroundImageSizeDesc'))
      .addDropdown(dropdown => dropdown
        .addOption('cover', t('backgroundSizeOptions.cover'))
        .addOption('contain', t('backgroundSizeOptions.contain'))
        .addOption('auto', t('backgroundSizeOptions.auto'))
        .setValue(this.context.plugin.settings.backgroundImageSize || 'cover')
        .onChange((value) => {
          if (!isBackgroundImageSize(value)) {
            return;
          }
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.backgroundImageSize = value;
          });
        }));

    // Background image position
    new Setting(container)
      .setName(t('settingsDetails.terminal.backgroundImagePosition'))
      .setDesc(t('settingsDetails.terminal.backgroundImagePositionDesc'))
      .addDropdown(dropdown => dropdown
        .addOption('center', t('backgroundPositionOptions.center'))
        .addOption('top', t('backgroundPositionOptions.top'))
        .addOption('bottom', t('backgroundPositionOptions.bottom'))
        .addOption('left', t('backgroundPositionOptions.left'))
        .addOption('right', t('backgroundPositionOptions.right'))
        .addOption('top left', t('backgroundPositionOptions.topLeft'))
        .addOption('top right', t('backgroundPositionOptions.topRight'))
        .addOption('bottom left', t('backgroundPositionOptions.bottomLeft'))
        .addOption('bottom right', t('backgroundPositionOptions.bottomRight'))
        .setValue(this.context.plugin.settings.backgroundImagePosition || 'center')
        .onChange((value) => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.backgroundImagePosition = value;
          });
        }));

    // Frosted glass effect
    const blurEffectSetting = new Setting(container)
      .setName(t('settingsDetails.terminal.blurEffect'))
      .setDesc(t('settingsDetails.terminal.blurEffectDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.enableBlur ?? false)
        .onChange((value) => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.enableBlur = value;
          });
          
          // Use a partial update instead of a full refresh
          this.toggleConditionalSection(
            container,
            'blur-amount-slider',
            value,
            (el) => this.renderBlurAmountSlider(el),
            blurEffectSetting.settingEl
          );
        }));

    // Frosted glass blur amount (shown only when the effect is enabled) - initial render
    this.toggleConditionalSection(
      container,
      'blur-amount-slider',
      this.context.plugin.settings.enableBlur ?? false,
      (el) => this.renderBlurAmountSlider(el),
      blurEffectSetting.settingEl
    );

    // Text opacity
    new Setting(container)
      .setName(t('settingsDetails.terminal.textOpacity'))
      .setDesc(t('settingsDetails.terminal.textOpacityDesc'))
      .addSlider(slider => slider
        .setLimits(0, 1, 0.05)
        .setValue(this.context.plugin.settings.textOpacity ?? 1.0)
        .setDynamicTooltip()
        .onChange((value) => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.textOpacity = value;
          });
        }));
  }

  /**
   * Render the blur amount slider
   * Extracted into a separate method for toggleConditionalSection
   */
  private renderBlurAmountSlider(container: HTMLElement): void {
    new Setting(container)
      .setName(t('settingsDetails.terminal.blurAmount'))
      .setDesc(t('settingsDetails.terminal.blurAmountDesc'))
      .addSlider(slider => slider
        .setLimits(0, 20, 1)
        .setValue(this.context.plugin.settings.blurAmount ?? 10)
        .setDynamicTooltip()
        .onChange((value) => {
          void this.updateThemeSetting(() => {
            this.context.plugin.settings.blurAmount = value;
          });
        }));
  }

  /**
   * Update background image settings visibility
   * Only takes effect after custom theme settings have been rendered
   */
  private updateBackgroundImageSettingsVisibility(): void {
    const customColorContainer = this.context.containerEl.querySelector<HTMLElement>(
      '.conditional-section-custom-color-settings'
    );
    if (!customColorContainer) {
      return;
    }

    const bgImageSettingEl = customColorContainer.querySelector<HTMLElement>(
      '.terminal-background-image-setting'
    );
    if (!bgImageSettingEl) {
      return;
    }

    this.toggleConditionalSection(
      customColorContainer,
      'background-image-webgl-hint',
      this.context.plugin.settings.preferredRenderer === 'webgl',
      (el) => {
        el.addClass('terminal-background-image-webgl-hint');
        el.createDiv({
          cls: 'setting-item-description',
          text: t('settingsDetails.terminal.backgroundImageWebglHint'),
        });
      },
      bgImageSettingEl
    );
  }

  private updateCustomColorSettingsVisibility(themeCard: HTMLElement, insertAfter: HTMLElement): void {
    const shouldShow = !this.context.plugin.settings.useObsidianTheme;
    this.toggleConditionalSection(
      themeCard,
      'custom-color-settings',
      shouldShow,
      (el) => this.renderCustomColorSettingsContent(el),
      insertAfter
    );

    if (!shouldShow) {
      themeCard.querySelectorAll('.conditional-section-custom-color-settings')
        .forEach((el) => el.remove());
    }
  }

  private requestThemeRefresh(): void {
    const leaves = this.context.app.workspace.getLeavesOfType('terminal-view-dev');
    leaves.forEach(leaf => {
      const view = asTerminalViewLike(leaf.view);
      view?.refreshAppearance?.();
    });
  }

  private applyScrollbackToOpenTerminals(scrollback: number): void {
    const leaves = this.context.app.workspace.getLeavesOfType('terminal-view-dev');
    leaves.forEach(leaf => {
      const view = asTerminalViewLike(leaf.view);
      view?.getTerminalInstance?.()?.updateOptions({ scrollback });
    });
  }

  private async updateThemeSetting(update: () => void): Promise<void> {
    update();
    await this.saveSettings();
    this.updateThemePreview();
    this.requestThemeRefresh();
  }

  private async updateAppearanceSetting(update: () => void): Promise<void> {
    update();
    await this.saveSettings();
    this.updateThemePreview();
    this.requestThemeRefresh();
  }

  private renderThemePreview(container: HTMLElement): void {
    const previewSection = container.createDiv({ cls: 'terminal-theme-preview-section' });
    previewSection.createDiv({
      cls: 'terminal-theme-preview-title',
      text: t('settingsDetails.terminal.themePreview'),
    });

    this.themePreviewEl = previewSection.createDiv({ cls: 'terminal-theme-preview' });
    this.themePreviewEl.createDiv({ cls: 'terminal-theme-preview-bg' });

    // Renderer badge in the top-right corner of the preview
    this.rendererStatusEl = this.themePreviewEl.createDiv({ cls: 'terminal-theme-preview-renderer-badge' });

    this.themePreviewContentEl = this.themePreviewEl.createDiv({ cls: 'terminal-theme-preview-content' });

    this.themePreviewContentEl.createDiv({ text: '$ echo "Termy"' });
    this.themePreviewContentEl.createDiv({ text: 'Termy' });
    this.themePreviewContentEl.createDiv({ text: '$ ls' });
    this.themePreviewContentEl.createDiv({ text: 'README.md  scripts  src  package.json' });
    const promptLine = this.themePreviewContentEl.createDiv({ cls: 'terminal-theme-preview-prompt-line' });
    promptLine.createSpan({ text: '$ ' });
    this.themePreviewCursorEl = promptLine.createSpan({ cls: 'terminal-theme-preview-cursor' });

    this.updateThemePreview();
    this.subscribeToRendererChanges();
    this.refreshRendererBadge();
  }

  private disposeRendererChangeSubscriptions(): void {
    for (const unsubscribe of this.rendererChangeUnsubscribers) {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    }
    this.rendererChangeUnsubscribers = [];
  }

  private disposeLauncherSnapshotSubscriptions(): void {
  }

  /**
   * Subscribe to renderer-change events on every alive terminal instance so the
   * badge reflects the actual addon swap (not a synchronous prediction made
   * before xterm finishes loading the new renderer).
   */
  private subscribeToRendererChanges(): void {
    const leaves = this.context.app.workspace.getLeavesOfType('terminal-view-dev');
    for (const leaf of leaves) {
      const view = asTerminalViewLike(leaf.view);
      const instance = view?.getTerminalInstance?.() ?? null;
      if (!instance?.isAlive?.() || !instance.onRendererChange) continue;
      const unsubscribe = instance.onRendererChange(() => {
        this.refreshRendererBadge();
      });
      this.rendererChangeUnsubscribers.push(unsubscribe);
    }
  }

  /**
   * Render the renderer badge. Prefers the live renderer reported by an open
   * terminal instance; falls back to the configured `preferredRenderer` when
   * no terminal is alive so the badge stays visible in the preview.
   */
  private refreshRendererBadge(): void {
    if (!this.rendererStatusEl) return;

    let actualRenderer: 'canvas' | 'webgl' | null = null;
    const leaves = this.context.app.workspace.getLeavesOfType('terminal-view-dev');
    for (const leaf of leaves) {
      const view = asTerminalViewLike(leaf.view);
      const instance = view?.getTerminalInstance?.() ?? null;
      if (instance?.isAlive?.() && instance.getCurrentRenderer) {
        actualRenderer = instance.getCurrentRenderer();
        break;
      }
    }

    if (!actualRenderer) {
      actualRenderer = this.context.plugin.settings.preferredRenderer ?? 'canvas';
    }

    const rendererLabel = actualRenderer === 'webgl'
      ? t('rendererOptions.webgl')
      : t('rendererOptions.canvas');

    this.rendererStatusEl.toggleClass('is-hidden', false);
    this.rendererStatusEl.setText(rendererLabel);
    this.rendererStatusEl.setAttribute('aria-label', rendererLabel);
    this.rendererStatusEl.setAttribute('title', rendererLabel);
  }

  private updateThemePreview(): void {
    if (!this.themePreviewEl) return;
    const settings = this.context.plugin.settings;

    const useObsidianTheme = settings.useObsidianTheme;
    const backgroundColor = useObsidianTheme
      ? 'var(--background-primary)'
      : (settings.backgroundColor || '#000000');
    const foregroundColor = useObsidianTheme
      ? 'var(--text-normal)'
      : (settings.foregroundColor || '#FFFFFF');

    const showBackgroundImage = !useObsidianTheme
      && !!settings.backgroundImage
      && settings.preferredRenderer !== 'webgl';

    if (showBackgroundImage) {
      this.themePreviewEl.classList.add('has-background-image');
    } else {
      this.themePreviewEl.classList.remove('has-background-image');
    }

    const backgroundImageOpacity = settings.backgroundImageOpacity ?? 0.5;
    const overlayOpacity = showBackgroundImage
      ? clamp(1 - backgroundImageOpacity, 0, 1)
      : 0;
    const blurAmount = settings.blurAmount ?? 0;
    const blurEnabled = showBackgroundImage && settings.enableBlur && blurAmount > 0;

    const fontSize = clamp(settings.fontSize ?? 14, 8, 24);
    const fontFamily = settings.fontFamily?.trim() || 'var(--font-monospace)';
    const cursorStyle = settings.cursorStyle ?? 'block';
    const cursorBlink = !!settings.cursorBlink;

    this.applyThemePreviewStyleRule({
      backgroundColor,
      foregroundColor,
      backgroundImage: showBackgroundImage ? toCssUrl(settings.backgroundImage) : 'none',
      overlayOpacity,
      backgroundSize: normalizeBackgroundSize(settings.backgroundImageSize),
      backgroundPosition: normalizeBackgroundPosition(settings.backgroundImagePosition),
      blur: blurEnabled ? `${blurAmount}px` : '0px',
      scale: blurEnabled ? '1.05' : '1',
      textOpacity: showBackgroundImage ? String(settings.textOpacity ?? 1.0) : '1',
      fontSize: `${fontSize}px`,
      fontFamily,
    });

    if (this.themePreviewCursorEl) {
      this.themePreviewCursorEl.classList.remove(
        'is-block',
        'is-underline',
        'is-bar',
      );
      this.themePreviewCursorEl.classList.add(`is-${cursorStyle}`);
      this.themePreviewCursorEl.classList.toggle('is-blinking', cursorBlink);
    }

    this.refreshRendererBadge();
  }

  private applyThemePreviewStyleRule(vars: {
    backgroundColor: string;
    foregroundColor: string;
    backgroundImage: string;
    overlayOpacity: number;
    backgroundSize: string;
    backgroundPosition: string;
    blur: string;
    scale: string;
    textOpacity: string;
    fontSize: string;
    fontFamily: string;
  }): void {
    if (!this.themePreviewEl) return;
    const style = this.themePreviewEl.style;
    style.setProperty('--terminal-preview-bg', vars.backgroundColor);
    style.setProperty('--terminal-preview-fg', vars.foregroundColor);
    style.setProperty('--terminal-preview-bg-image', vars.backgroundImage);
    style.setProperty('--terminal-preview-bg-overlay-opacity', String(vars.overlayOpacity));
    style.setProperty('--terminal-preview-bg-size', vars.backgroundSize);
    style.setProperty('--terminal-preview-bg-position', vars.backgroundPosition);
    style.setProperty('--terminal-preview-bg-blur', vars.blur);
    style.setProperty('--terminal-preview-bg-scale', vars.scale);
    style.setProperty('--terminal-preview-text-opacity', vars.textOpacity);
    style.setProperty('--terminal-preview-font-size', vars.fontSize);
    style.setProperty('--terminal-preview-font-family', vars.fontFamily);
  }

  /**
   * Render behavior settings
   */
  private renderBehaviorSettings(containerEl: HTMLElement): void {
    const behaviorCard = containerEl.createDiv({ cls: 'settings-card' });

    new Setting(behaviorCard)
      .setName(t('settingsDetails.terminal.behaviorSettings'))
      .setHeading();

    // Scrollback buffer size
    new Setting(behaviorCard)
      .setName(t('settingsDetails.terminal.scrollback'))
      .setDesc(t('settingsDetails.terminal.scrollbackDesc'))
      .addText(text => {
      const inputEl = text
        .setPlaceholder('1000')
        .setValue(String(this.context.plugin.settings.scrollback))
        .onChange((value) => {
          // Save only while typing, without validation
          const numValue = parseInt(value);
          if (!isNaN(numValue)) {
            this.context.plugin.settings.scrollback = numValue;
            void this.saveSettings();
            this.applyScrollbackToOpenTerminals(numValue);
          }
        });
      
      // Validate on blur
      text.inputEl.addEventListener('blur', () => {
        const value = text.inputEl.value;
        const numValue = parseInt(value);
        if (isNaN(numValue) || numValue < 100 || numValue > 10000) {
          new Notice('⚠️ ' + t('notices.settings.scrollbackRangeError'));
          this.context.plugin.settings.scrollback = 1000;
          void this.saveSettings();
          text.setValue('1000');
          this.applyScrollbackToOpenTerminals(1000);
          return;
        }
        this.applyScrollbackToOpenTerminals(numValue);
      });
      
      return inputEl;
    });

  }

  /**
   * Validate the custom Shell path
   * @param containerEl Container element
   * @param path Shell path
   */
  private validateCustomShellPath(containerEl: HTMLElement, path: string): void {
    // Remove the previous validation message
    const existingValidation = containerEl.querySelector('.shell-path-validation');
    if (existingValidation) {
      existingValidation.remove();
    }
    
    // If the path is empty, do not show a validation message
    if (!path || path.trim() === '') {
      return;
    }
    
    // Create the validation message container
    const validationEl = containerEl.createDiv({
      cls: 'shell-path-validation setting-item-description terminal-settings-validation'
    });
    
    // Validate the path
    const isValid = validateShellPath(path);
    if (!validationEl.isConnected) return;

    if (isValid) {
      validationEl.setText(t('settingsDetails.terminal.pathValid'));
      validationEl.addClass('is-valid');
    } else {
      validationEl.setText(t('settingsDetails.terminal.pathInvalid'));
      validationEl.addClass('is-invalid');
    }
  }

  private confirmPresetScriptDelete(scriptName: string): Promise<boolean> {
    return confirmAction(
      this.context.app,
      t('settingsDetails.terminal.presetScriptsDeleteConfirm', { name: scriptName })
    );
  }

  private confirmPresetScriptReset(scriptName: string): Promise<boolean> {
    return confirmAction(
      this.context.app,
      t('settingsDetails.terminal.presetScriptsResetConfirm', { name: scriptName })
    );
  }

  /**
   * Render feature visibility settings
   */
  private renderVisibilitySettings(containerEl: HTMLElement): void {
    const visibilityCard = containerEl.createDiv({ cls: 'settings-card' });

    new Setting(visibilityCard)
      .setName(t('visibility.visibilitySettings'))
      .setHeading();

    // Show in the command palette
    new Setting(visibilityCard)
      .setName(t('visibility.showInCommandPalette'))
      .setDesc(t('visibility.showInCommandPaletteDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.visibility.showInCommandPalette)
        .onChange((value) => {
          this.context.plugin.settings.visibility.showInCommandPalette = value;
          void this.saveSettings();
          this.context.plugin.updateFeatureVisibility();
        }));

    // Show the icon in the ribbon
    new Setting(visibilityCard)
      .setName(t('visibility.showInRibbon'))
      .setDesc(t('visibility.showInRibbonDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.visibility.showInRibbon)
        .onChange((value) => {
          this.context.plugin.settings.visibility.showInRibbon = value;
          void this.saveSettings();
          this.context.plugin.updateFeatureVisibility();
        }));

    // Show in the new tab view
    new Setting(visibilityCard)
      .setName(t('visibility.showInNewTab'))
      .setDesc(t('visibility.showInNewTabDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.visibility.showInNewTab)
        .onChange((value) => {
          this.context.plugin.settings.visibility.showInNewTab = value;
          void this.saveSettings();
          this.context.plugin.updateFeatureVisibility();
        }));

    // Show in the status bar
    new Setting(visibilityCard)
      .setName(t('visibility.showInStatusBar'))
      .setDesc(t('visibility.showInStatusBarDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.visibility.showInStatusBar)
        .onChange((value) => {
          this.context.plugin.settings.visibility.showInStatusBar = value;
          void this.saveSettings();
          this.context.plugin.updateFeatureVisibility();
        }));

    // Debug settings card
    const debugCard = containerEl.createDiv({ cls: 'settings-card' });

    new Setting(debugCard)
      .setName(t('settingsDetails.advanced.performanceAndDebug'))
      .setHeading();

    // Enable debug logging
    new Setting(debugCard)
      .setName(t('settingsDetails.advanced.debugMode'))
      .setDesc(t('settingsDetails.advanced.debugModeDesc'))
      .addToggle(toggle => toggle
        .setValue(this.context.plugin.settings.enableDebugLog)
        .onChange((value) => {
          this.context.plugin.settings.enableDebugLog = value;
          void this.saveSettings().then(() => {
            new Notice(value
              ? t('notices.settings.debugLogEnabled')
              : t('notices.settings.debugLogDisabled'));
          });
        }));
  }
}
