import type { IImageAddonOptions } from '@xterm/addon-image';

export const SIXEL_IMAGE_STORAGE_LIMIT_MB = 32;

export function createTerminalImageAddonOptions(): IImageAddonOptions {
  return {
    enableSizeReports: true,
    sixelSupport: true,
    iipSupport: false,
    storageLimit: SIXEL_IMAGE_STORAGE_LIMIT_MB,
    showPlaceholder: true,
  };
}
