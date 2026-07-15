const KITTY_APC_START = '\x1b_G';
const STRING_TERMINATOR = '\x1b\\';
const MAX_KITTY_IMAGE_BASE64_LENGTH = 20 * 1024 * 1024;

export const TERMY_KITTY_GRAPHICS_OSC = 996;

interface KittyGraphicsCommand {
  params: Record<string, string>;
  payload: string;
}

export interface KittyGraphicsCursorPosition {
  x: number;
  y: number;
}

export interface KittyGraphicsImagePlacement extends KittyGraphicsCursorPosition {
  imageId: number;
  columns: number;
  rows: number;
  base64Png: string;
}

export type KittyGraphicsAction =
  | { type: 'render'; image: KittyGraphicsImagePlacement }
  | { type: 'delete'; imageId: number }
  | { type: 'delete-all' };

export interface KittyGraphicsMarkerResult {
  handled: boolean;
  action: KittyGraphicsAction | null;
}

interface PendingKittyTransfer {
  imageId: number;
  columns: number;
  rows: number;
  x: number;
  y: number;
  base64Png: string;
}

export interface KittyGraphicsLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface KittyGraphicsTerminalLike {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
}

/**
 * xterm.js deliberately ignores APC strings, which is where the Kitty graphics
 * protocol lives. Replace each Kitty APC with a private OSC marker so xterm can
 * advance through the surrounding cursor commands normally. The OSC handler is
 * then invoked at the exact screen position where the image was emitted.
 */
export class KittyGraphicsProtocolBridge {
  private pendingOutput = '';
  private nextMarkerId = 1;
  private markerCommands = new Map<string, KittyGraphicsCommand>();
  private pendingTransfer: PendingKittyTransfer | null = null;

  transformOutput(data: string): string {
    let buffer = this.pendingOutput + data;
    this.pendingOutput = '';
    let output = '';

    while (buffer.length > 0) {
      const startIndex = buffer.indexOf(KITTY_APC_START);
      if (startIndex === -1) {
        const retainedLength = partialKittyApcPrefixLength(buffer);
        output += buffer.slice(0, buffer.length - retainedLength);
        this.pendingOutput = buffer.slice(buffer.length - retainedLength);
        break;
      }

      output += buffer.slice(0, startIndex);
      const endIndex = buffer.indexOf(
        STRING_TERMINATOR,
        startIndex + KITTY_APC_START.length,
      );
      if (endIndex === -1) {
        this.pendingOutput = buffer.slice(startIndex);
        break;
      }

      const rawCommand = buffer.slice(
        startIndex + KITTY_APC_START.length,
        endIndex,
      );
      const command = parseKittyGraphicsCommand(rawCommand);
      if (command) {
        const marker = `termy-kitty-${this.nextMarkerId++}`;
        this.markerCommands.set(marker, command);
        output += `\x1b]${TERMY_KITTY_GRAPHICS_OSC};${marker}\x07`;
      } else {
        // Preserve malformed commands. xterm will ignore the APC, matching its
        // normal behavior without Termy's compatibility layer.
        output += buffer.slice(startIndex, endIndex + STRING_TERMINATOR.length);
      }

      buffer = buffer.slice(endIndex + STRING_TERMINATOR.length);
    }

    return output;
  }

  consumeMarker(
    marker: string,
    cursor: KittyGraphicsCursorPosition,
  ): KittyGraphicsMarkerResult {
    const command = this.markerCommands.get(marker);
    if (!command) {
      return { handled: false, action: null };
    }
    this.markerCommands.delete(marker);

    return {
      handled: true,
      action: this.consumeCommand(command, cursor),
    };
  }

  reset(): void {
    this.pendingOutput = '';
    this.markerCommands.clear();
    this.pendingTransfer = null;
  }

  private consumeCommand(
    command: KittyGraphicsCommand,
    cursor: KittyGraphicsCursorPosition,
  ): KittyGraphicsAction | null {
    const action = command.params.a;
    if (action === 'd') {
      this.pendingTransfer = null;
      const deleteMode = command.params.d;
      if (deleteMode === 'a' || deleteMode === 'A') {
        return { type: 'delete-all' };
      }

      const imageId = parseUnsignedInteger(command.params.i);
      if ((deleteMode === 'i' || deleteMode === 'I') && imageId !== null) {
        return { type: 'delete', imageId };
      }
      return null;
    }

    if (action === 'T') {
      const imageId = parseUnsignedInteger(command.params.i);
      const columns = parsePositiveInteger(command.params.c);
      const rows = parsePositiveInteger(command.params.r);
      if (
        command.params.t !== 'd'
        || command.params.f !== '100'
        || imageId === null
        || columns === null
        || rows === null
      ) {
        this.pendingTransfer = null;
        return null;
      }

      this.pendingTransfer = {
        imageId,
        columns,
        rows,
        x: cursor.x,
        y: cursor.y,
        base64Png: command.payload,
      };
      return this.finishTransferIfComplete(command.params.m);
    }

    if (!action && this.pendingTransfer) {
      this.pendingTransfer.base64Png += command.payload;
      return this.finishTransferIfComplete(command.params.m);
    }

    return null;
  }

  private finishTransferIfComplete(moreFlag: string | undefined): KittyGraphicsAction | null {
    const transfer = this.pendingTransfer;
    if (!transfer) {
      return null;
    }
    if (transfer.base64Png.length > MAX_KITTY_IMAGE_BASE64_LENGTH) {
      this.pendingTransfer = null;
      return null;
    }
    if (moreFlag === '1') {
      return null;
    }

    this.pendingTransfer = null;
    if (!isBase64Payload(transfer.base64Png)) {
      return null;
    }

    return {
      type: 'render',
      image: transfer,
    };
  }
}

/** Render direct-data PNG placements used by Codex pets. */
export class KittyGraphicsRenderer {
  private readonly images = new Map<number, KittyGraphicsImagePlacement>();
  private readonly imageElements = new Map<number, HTMLImageElement>();
  private readonly terminal: KittyGraphicsTerminalLike;
  private layer: HTMLElement | null = null;

  constructor(terminal: KittyGraphicsTerminalLike) {
    this.terminal = terminal;
  }

  apply(action: KittyGraphicsAction): void {
    if (action.type === 'delete-all') {
      this.clear();
      return;
    }
    if (action.type === 'delete') {
      this.images.delete(action.imageId);
      this.imageElements.get(action.imageId)?.remove();
      this.imageElements.delete(action.imageId);
      if (this.images.size === 0) {
        this.layer?.remove();
        this.layer = null;
      }
      return;
    }

    this.images.set(action.image.imageId, action.image);
    this.refresh();
  }

  refresh(): void {
    if (this.images.size === 0) {
      return;
    }
    const screen = this.terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) {
      return;
    }

    const layer = this.ensureLayer(screen);
    // Renderer swaps can append a new text canvas. Keep the transparent image
    // layer after it within the same z-index so images stay visible.
    screen.appendChild(layer);

    const rect = screen.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || this.terminal.cols <= 0 || this.terminal.rows <= 0) {
      return;
    }

    for (const image of this.images.values()) {
      const element = this.ensureImageElement(layer, image.imageId);
      const layout = calculateKittyGraphicsLayout(
        image,
        this.terminal.cols,
        this.terminal.rows,
        rect.width,
        rect.height,
      );
      element.style.left = `${layout.left}px`;
      element.style.top = `${layout.top}px`;
      element.style.width = `${layout.width}px`;
      element.style.height = `${layout.height}px`;
      const nextSource = `data:image/png;base64,${image.base64Png}`;
      if (element.src !== nextSource) {
        element.src = nextSource;
      }
    }
  }

  clear(): void {
    this.images.clear();
    this.imageElements.clear();
    this.layer?.remove();
    this.layer = null;
  }

  dispose(): void {
    this.clear();
  }

  private ensureLayer(screen: HTMLElement): HTMLElement {
    if (this.layer?.parentElement === screen) {
      return this.layer;
    }

    this.layer?.remove();
    this.imageElements.clear();
    const layer = screen.ownerDocument.createElement('div');
    layer.className = 'termy-kitty-image-layer';
    screen.appendChild(layer);
    this.layer = layer;
    return layer;
  }

  private ensureImageElement(layer: HTMLElement, imageId: number): HTMLImageElement {
    const existing = this.imageElements.get(imageId);
    if (existing?.parentElement === layer) {
      return existing;
    }

    const image = layer.ownerDocument.createElement('img');
    image.className = 'termy-kitty-image';
    image.alt = '';
    image.draggable = false;
    image.dataset.kittyImageId = String(imageId);
    layer.appendChild(image);
    this.imageElements.set(imageId, image);
    return image;
  }
}

export function calculateKittyGraphicsLayout(
  image: Pick<KittyGraphicsImagePlacement, 'x' | 'y' | 'columns' | 'rows'>,
  terminalColumns: number,
  terminalRows: number,
  screenWidth: number,
  screenHeight: number,
): KittyGraphicsLayout {
  const cellWidth = screenWidth / terminalColumns;
  const cellHeight = screenHeight / terminalRows;
  return {
    left: image.x * cellWidth,
    top: image.y * cellHeight,
    width: image.columns * cellWidth,
    height: image.rows * cellHeight,
  };
}

function parseKittyGraphicsCommand(raw: string): KittyGraphicsCommand | null {
  const separatorIndex = raw.indexOf(';');
  const control = separatorIndex === -1 ? raw : raw.slice(0, separatorIndex);
  const payload = separatorIndex === -1 ? '' : raw.slice(separatorIndex + 1);
  const params: Record<string, string> = {};

  for (const part of control.split(',')) {
    const equalsIndex = part.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    params[part.slice(0, equalsIndex)] = part.slice(equalsIndex + 1);
  }

  if (Object.keys(params).length === 0) {
    return null;
  }
  return { params, payload };
}

function partialKittyApcPrefixLength(buffer: string): number {
  const maxLength = Math.min(KITTY_APC_START.length - 1, buffer.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (KITTY_APC_START.startsWith(buffer.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function parseUnsignedInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = parseUnsignedInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function isBase64Payload(payload: string): boolean {
  if (payload.length === 0 || payload.length % 4 === 1) {
    return false;
  }
  return /^[A-Za-z0-9+/]*={0,2}$/.test(payload);
}
