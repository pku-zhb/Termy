import type { App } from 'obsidian';
import { Modal } from 'obsidian';

import { t } from '../../i18n';

interface ConfirmCloseTerminalModalOptions {
  title: string;
  message: string;
  confirmText: string;
}

export class ConfirmCloseTerminalModal extends Modal {
  private readonly options: ConfirmCloseTerminalModalOptions;
  private readonly onResolve: (confirmed: boolean) => void;
  private resolved = false;

  constructor(
    app: App,
    options: ConfirmCloseTerminalModalOptions,
    onResolve: (confirmed: boolean) => void,
  ) {
    super(app);
    this.options = options;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h2', { text: this.options.title });
    contentEl.createEl('p', { text: this.options.message });

    const buttonContainer = contentEl.createDiv('modal-button-container');
    const cancelButton = buttonContainer.createEl('button', {
      text: t('common.cancel'),
    });
    cancelButton.addEventListener('click', () => this.resolve(false));

    const confirmButton = buttonContainer.createEl('button', {
      cls: 'mod-warning',
      text: this.options.confirmText,
    });
    confirmButton.addEventListener('click', () => this.resolve(true));
    confirmButton.focus();
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.onResolve(false);
    }
  }

  private resolve(confirmed: boolean): void {
    if (this.resolved) {
      return;
    }

    this.resolved = true;
    this.onResolve(confirmed);
    this.close();
  }
}

export function confirmCloseTerminal(
  app: App,
  options: ConfirmCloseTerminalModalOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmCloseTerminalModal(app, options, resolve).open();
  });
}
