/**
 * Terminal instance class - a PtyClient-based implementation built on the unified Rust server
 * 

 */

import { debugLog, debugWarn, errorLog } from '@/utils/logger';
import { getHomeDir, getPlatform, isWindows } from '@/utils/platform';
import { t } from '@/i18n';
import type { ServerManager } from '@/services/server/serverManager';
import type { PtyClient } from '@/services/server/ptyClient';
import type { ForegroundInfo, PtyConfig, ShellEvent, ShellEventSource } from '@/services/server/types';
import type { DefaultShellOption } from './terminalService';
import { EnhancedKeyboardProtocol, formatPastedTerminalText } from './enhancedKeyboardProtocol';
import {
  isImeCommitFallbackText,
  shouldScheduleImeCommitFallbackForBeforeInput,
} from './imeCommitFallback';
import { computeImeCompositionViewLayout } from './imeCompositionView';
import {
  matchKeybinding,
  DEFAULT_KEYBINDING_RULES,
  type KeybindingMatch,
  type KeybindingRule,
} from './keybindingRules';
import {
  createSynchronizedOutputCompatibilityState,
  filterSynchronizedOutputScrollbackPurge,
} from './aiTuiCompatibility';
import {
  buildClaudeCodeTuiEnv,
  decodeOsc52Clipboard,
  decodeTmuxPassthroughOsc52Clipboard,
  formatOscColorResponse,
  type ClaudeCodeExtendedKeyboardMode,
  XTVERSION_RESPONSE,
} from './claudeCodeTuiSupport';
import { ClaudeCodeSessionState } from './claudeCodeSessionState';
import { createTerminalImageAddonOptions } from './terminalImageSupport';
import {
  KittyGraphicsProtocolBridge,
  KittyGraphicsRenderer,
  TERMY_KITTY_GRAPHICS_OSC,
} from './kittyGraphicsSupport';
import { TerminalTitleState } from './terminalTitleState';
import { resolveTerminalContextMenuAction } from './terminalContextMenuRouter';
import {
  extractCmdCwd,
  extractCwdFromPromptLines,
  extractGitBashPromptCwd,
  extractGitBashWindowTitleCwd,
  extractPowerShellCwd,
  extractWslPromptCwd,
} from './promptCwdParsers';
import { shell } from 'electron';

// xterm.js CSS (static import handled by esbuild)
import '@xterm/xterm/css/xterm.css';

// xterm.js module type declarations (for dynamic import)
type Terminal = import('@xterm/xterm').Terminal;
type FitAddon = import('@xterm/addon-fit').FitAddon;
type SearchAddon = import('@xterm/addon-search').SearchAddon;
type CanvasAddon = import('@xterm/addon-canvas').CanvasAddon;
type WebglAddon = import('@xterm/addon-webgl').WebglAddon;
type IMarker = import('@xterm/xterm').IMarker;
type IDisposable = import('@xterm/xterm').IDisposable;

type TerminalTheme = Record<string, string>;

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

const IME_COMMIT_FALLBACK_DELAY_MS = 16;
const IME_COMMIT_RECENT_DATA_WINDOW_MS = 32;

function parsePixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const XTERM_BACKGROUND_LAYER_SELECTOR = [
  '.xterm',
  '.xterm-viewport',
  '.xterm-scrollable-element',
  '.xterm-screen',
  '.xterm-canvas',
  'canvas',
].join(', ');
const XTERM_SCROLL_BACKGROUND_LAYER_SELECTOR = '.xterm-viewport, .xterm-scrollable-element';

// xterm.js module cache
let xtermModules: {
  Terminal: typeof import('@xterm/xterm').Terminal;
  FitAddon: typeof import('@xterm/addon-fit').FitAddon;
  SearchAddon: typeof import('@xterm/addon-search').SearchAddon;
  CanvasAddon: typeof import('@xterm/addon-canvas').CanvasAddon;
  WebglAddon: typeof import('@xterm/addon-webgl').WebglAddon;
  ImageAddon: typeof import('@xterm/addon-image').ImageAddon;
} | null = null;

/**
 * Dynamically load xterm.js modules (loaded on first use and cached afterward)
 * @throws {Error} If module loading fails
 */
async function loadXtermModules() {
  // Return cached modules immediately if available
  if (xtermModules) {
    debugLog('[Terminal] 使用缓存的 xterm.js 模块');
    return xtermModules;
  }
  
  debugLog('[Terminal] 动态加载 xterm.js 模块...');
  
  try {
    const [
      { Terminal },
      { FitAddon },
      { SearchAddon },
      { CanvasAddon },
      { WebglAddon },
      { ImageAddon },
    ] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-search'),
      import('@xterm/addon-canvas'),
      import('@xterm/addon-webgl'),
      import('@xterm/addon-image'),
    ]);
    
    // Verify that all modules were loaded successfully
    if (!Terminal || !FitAddon || !SearchAddon || !CanvasAddon || !WebglAddon || !ImageAddon) {
      throw new Error('One or more xterm.js modules failed to load');
    }
    
    xtermModules = { Terminal, FitAddon, SearchAddon, CanvasAddon, WebglAddon, ImageAddon };
    debugLog('[Terminal] xterm.js 模块加载完成');
    
    return xtermModules;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    errorLog('[Terminal] xterm.js 模块加载失败:', error);
    
    // Clear any partial cache that may have been created
    xtermModules = null;
    
    throw new Error(t('terminalInstance.xtermLoadFailed', { message: errorMsg }));
  }
}

export interface TerminalOptions {
  shellType?: string;
  shellArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: 'block' | 'underline' | 'bar';
  cursorBlink?: boolean;
  scrollback?: number;
  preferredRenderer?: 'canvas' | 'webgl';
  useObsidianTheme?: boolean;
  backgroundColor?: string;
  foregroundColor?: string;
  backgroundImage?: string;
  backgroundImageOpacity?: number;
  backgroundImageSize?: 'cover' | 'contain' | 'auto';
  backgroundImagePosition?: string;
  enableBlur?: boolean;
  blurAmount?: number;
  textOpacity?: number;
  /** 键盘路由规则（由用户设置编译而来）；省略时用内置默认。 */
  keybindingRules?: KeybindingRule[];
}

/** Search state change callback */
export type SearchStateCallback = (visible: boolean) => void;
/** Font size change callback */
export type FontSizeChangeCallback = (fontSize: number) => void;
/** Renderer change callback */
export type RendererChangeCallback = (renderer: 'canvas' | 'webgl') => void;

interface TerminalCommandMarker {
  marker: IMarker;
  exitCode: number | null;
}

export type TermyTabNavAction =
  | { type: 'new' }
  | { type: 'close' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; index: number }
  | { type: 'rename' };

export class TerminalInstance {
  readonly id: string;
  readonly shellType: string;

  private xterm!: Terminal;
  private fitAddon!: FitAddon;
  private searchAddon!: SearchAddon;
  private renderer: CanvasAddon | WebglAddon | null = null;
  private rendererType: 'canvas' | 'webgl' | null = null;
  
  // Use PtyClient instead of a direct WebSocket
  private ptyClient: PtyClient | null = null;
  
  // Session ID (multi-session support)
  private sessionId: string | null = null;
  
  // Event unsubscribe callbacks
  private outputUnsubscribe: (() => void) | null = null;
  private exitUnsubscribe: (() => void) | null = null;
  private errorUnsubscribe: (() => void) | null = null;
  private shellEventUnsubscribe: (() => void) | null = null;
  private foregroundUnsubscribe: (() => void) | null = null;
  
  private containerEl: HTMLElement | null = null;
  private options: TerminalOptions;
  private titleState: TerminalTitleState;
  private isInitialized = false;
  private isDestroyed = false;
  private titleChangeCallbacks: Set<(title: string) => void> = new Set();
  
  // Search-related state
  private searchVisible = false;
  private searchStateCallbacks: Set<SearchStateCallback> = new Set();
  private lastSearchQuery = '';
  
  // Font size state
  private currentFontSize: number;
  private fontSizeChangeCallbacks: Set<FontSizeChangeCallback> = new Set();
  private readonly minFontSize = 8;
  private readonly maxFontSize = 32;

  // Renderer change listeners
  private rendererChangeCallbacks: Set<RendererChangeCallback> = new Set();

  // Input batching
  private pendingInput: string[] = [];
  private inputFlushTimer: number | null = null;
  private readonly inputBatchIntervalMs = 4;
  private pendingImeCommitFallbackTimer: number | null = null;
  private pendingImeCommitFallbackText = '';
  private isComposing = false;
  private lastXtermInputData = '';
  private lastXtermInputDataAt = 0;

  // 键盘路由规则（可被用户设置覆盖、可热更新）
  private keybindingRules: KeybindingRule[] = DEFAULT_KEYBINDING_RULES;

  // Context menu callbacks for actions like split/new terminal that need external handling
  private contextMenuCallbacks: {
    onNewTerminal?: () => void;
    onSplitTerminal?: (direction: 'horizontal' | 'vertical') => void;
    getDefaultShellOptions?: () => DefaultShellOption[];
    onDefaultShellChange?: (shellType: DefaultShellOption['shellType']) => void;
  } = {};

  // Current working directory (extracted from shell prompt output)
  private currentCwd: string | null = null;

  // Shell integration events
  private shellEventCallback: ((event: ShellEvent) => void) | null = null;
  private foregroundCallback: ((info: ForegroundInfo) => void) | null = null;
  private currentForeground: ForegroundInfo | null = null;
  private commandHistory: Array<{
    startTime: number;
    endTime: number;
    durationMs: number;
    exitCode: number | null;
    source: ShellEventSource;
  }> = [];
  private activeCommandStart: number | null = null;
  private promptMarkers: IMarker[] = [];
  private commandMarkers: TerminalCommandMarker[] = [];
  private win32InputModeEnabled = false;
  private claudeCodeSessionState = new ClaudeCodeSessionState();
  private webSocketDisconnected = false;
  private sessionRecoveryNeeded = false;
  private sessionRecoveryInProgress = false;
  private pendingControlSequenceText = '';
  private synchronizedOutputCompatibilityState = createSynchronizedOutputCompatibilityState();
  private kittyGraphicsProtocol = new KittyGraphicsProtocolBridge();
  private kittyGraphicsRenderer: KittyGraphicsRenderer | null = null;
  private parserDisposables: IDisposable[] = [];
  private domEventCleanups: Array<() => void> = [];
  private hostWindow: Window | null = null;

  constructor(options: TerminalOptions = {}) {
    this.id = `terminal-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    this.options = options;
    if (options.keybindingRules && options.keybindingRules.length > 0) {
      this.keybindingRules = options.keybindingRules;
    }
    this.shellType = options.shellType || 'default';
    this.titleState = new TerminalTitleState(t('terminal.defaultTitle'));
    this.currentFontSize = options.fontSize ?? 14;
  }

  /**
   * Initialize the xterm.js instance (modules loaded dynamically)
   * @throws {Error} If module loading or initialization fails
   */
  private async initXterm(): Promise<void> {
    try {
      const { Terminal, FitAddon, SearchAddon, ImageAddon } = await loadXtermModules();
      
      this.xterm = new Terminal({
        cursorBlink: this.options.cursorBlink ?? true,
        cursorStyle: this.options.cursorStyle ?? 'block',
        fontSize: this.currentFontSize,
        fontFamily: this.options.fontFamily ?? 'Consolas, "Courier New", monospace',
        theme: this.getTheme(),
        scrollback: this.options.scrollback ?? 1000,
        allowTransparency: this.shouldUseTransparentTerminalBackground(),
        convertEol: false,
        rightClickSelectsWord: true,
        macOptionClickForcesSelection: true,
        rescaleOverlappingGlyphs: true,
        scrollOnEraseInDisplay: true,
        allowProposedApi: true,
      });

      this.fitAddon = new FitAddon();
      this.searchAddon = new SearchAddon();
      const imageAddon = new ImageAddon(createTerminalImageAddonOptions());
      
      this.xterm.loadAddon(this.fitAddon);
      this.xterm.loadAddon(this.searchAddon);
      this.xterm.loadAddon(imageAddon);
      this.kittyGraphicsRenderer = new KittyGraphicsRenderer(this.xterm);
      
      this.setupClaudeCodeTuiHandlers();
      this.parserDisposables.push(
        this.xterm.onResize(() => {
          this.kittyGraphicsRenderer?.refresh();
        }),
      );
      
      debugLog('[Terminal] xterm.js 实例初始化完成');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errorLog('[Terminal] xterm.js 初始化失败:', error);
      throw new Error(t('terminalInstance.xtermInitFailed', { message: errorMsg }));
    }
  }

  private getTheme(): TerminalTheme {
    const { useObsidianTheme, backgroundColor, foregroundColor } = this.options;

    if (useObsidianTheme) {
      const isDark = activeDocument.body.classList.contains('theme-dark');
      const computed = activeDocument.defaultView?.getComputedStyle(activeDocument.body);
      const bgFromVar = computed?.getPropertyValue('--background-primary').trim();
      const fgFromVar = computed?.getPropertyValue('--text-normal').trim();
      const cursorFromVar = computed?.getPropertyValue('--text-normal').trim();
      const background = bgFromVar || (isDark ? '#1e1e1e' : '#ffffff');
      const foreground = fgFromVar || (isDark ? '#cccccc' : '#333333');

      return {
        background,
        foreground,
        cursor: cursorFromVar || foreground,
        cursorAccent: background,
        ...this.buildObsidianAnsiPalette(computed, background, foreground, isDark),
      };
    }

    const bgColor = this.shouldUseTransparentTerminalBackground()
      ? 'transparent'
      : (backgroundColor || '#000000');
    const isDark = backgroundColor ? this.isColorDark(backgroundColor) : true;
    
    return {
      background: bgColor,
      foreground: foregroundColor || '#FFFFFF',
      cursor: foregroundColor || '#FFFFFF',
      cursorAccent: backgroundColor || '#000000',
      selectionBackground: isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.3)',
    };
  }

  private isColorDark(color: string): boolean {
    const rgb = this.colorToRgb(color);
    if (!rgb) {
      return true;
    }
    return this.relativeLuminance(rgb) < 0.5;
  }

  private buildObsidianAnsiPalette(
    computed: CSSStyleDeclaration | undefined,
    backgroundColor: string,
    foregroundColor: string,
    isDark: boolean,
  ): TerminalTheme {
    const background = this.colorToRgb(backgroundColor) ?? (isDark ? { r: 30, g: 30, b: 30 } : { r: 255, g: 255, b: 255 });
    const foreground = this.colorToRgb(foregroundColor) ?? (isDark ? { r: 204, g: 204, b: 204 } : { r: 51, g: 51, b: 51 });

    const primaryColor = this.resolveThemeColor(
      computed,
      ['--_primary', '--seed-primary', '--text-accent', '--interactive-accent'],
      isDark ? '#4cc9f0' : '#0e9aa7',
    );
    const primary = this.ensureReadableAccentColor(
      this.colorToRgb(primaryColor) ?? (isDark ? { r: 76, g: 201, b: 240 } : { r: 14, g: 154, b: 167 }),
      background,
      isDark,
    );

    const secondaryColor = this.resolveThemeColor(
      computed,
      ['--_secondary', '--seed-secondary', '--accent-bold', '--accent-highlight'],
      '',
    );
    const secondaryBase = this.colorToRgb(secondaryColor)
      ?? this.shiftAccentLightness(primary, isDark ? 0.08 : -0.08);
    const secondary = this.ensureReadableAccentColor(secondaryBase, background, isDark);

    return {
      black: this.rgbToCss(isDark ? this.mixColors(background, foreground, 0.14) : foreground),
      red: this.rgbToCss(primary),
      green: this.rgbToCss(primary),
      yellow: this.rgbToCss(primary),
      blue: this.rgbToCss(primary),
      magenta: this.rgbToCss(primary),
      cyan: this.rgbToCss(secondary),
      white: this.rgbToCss(isDark ? this.mixColors(background, foreground, 0.78) : this.mixColors(background, foreground, 0.70)),
      brightBlack: this.rgbToCss(this.mixColors(background, foreground, isDark ? 0.34 : 0.50)),
      brightRed: this.rgbToCss(primary),
      brightGreen: this.rgbToCss(primary),
      brightYellow: this.rgbToCss(primary),
      brightBlue: this.rgbToCss(primary),
      brightMagenta: this.rgbToCss(primary),
      brightCyan: this.rgbToCss(secondary),
      brightWhite: this.rgbToCss(foreground),
      selectionBackground: this.rgbToRgba(primary, isDark ? 0.38 : 0.28),
      selectionForeground: this.rgbToCss(foreground),
    };
  }

  private resolveThemeColor(
    computed: CSSStyleDeclaration | undefined,
    variableNames: string[],
    fallback: string,
  ): string {
    for (const variableName of variableNames) {
      const rawValue = computed?.getPropertyValue(variableName).trim();
      if (!rawValue) {
        continue;
      }

      const resolvedVariable = this.resolveCssColor(`var(${variableName})`);
      if (resolvedVariable) {
        return resolvedVariable;
      }

      const resolvedValue = this.resolveCssColor(rawValue);
      if (resolvedValue) {
        return resolvedValue;
      }
    }

    return fallback;
  }

  private resolveCssColor(color: string): string | null {
    const candidate = color.trim();
    if (!candidate) {
      return null;
    }

    const probe = activeDocument.createElement('span');
    probe.style.position = 'fixed';
    probe.style.pointerEvents = 'none';
    probe.style.visibility = 'hidden';
    probe.style.color = candidate;

    if (!probe.style.color) {
      return null;
    }

    activeDocument.body.appendChild(probe);
    const resolved = activeDocument.defaultView?.getComputedStyle(probe).color.trim() || null;
    probe.remove();

    return resolved;
  }

  private colorToRgb(color: string): RgbColor | null {
    const resolved = this.resolveCssColor(color) ?? color.trim();
    return this.parseRgbColor(resolved) ?? this.parseHexColor(resolved) ?? this.parseSrgbColor(resolved);
  }

  private parseRgbColor(color: string): RgbColor | null {
    const match = color.match(/^rgba?\((.+)\)$/i);
    if (!match) {
      return null;
    }

    const components = match[1]
      .replaceAll(',', ' ')
      .split('/')
      .shift()
      ?.trim()
      .split(/\s+/)
      .slice(0, 3);
    if (!components || components.length < 3) {
      return null;
    }

    const [r, g, b] = components.map((component) => this.parseRgbComponent(component));
    if ([r, g, b].some((component) => component === null)) {
      return null;
    }

    return { r: r as number, g: g as number, b: b as number };
  }

  private parseHexColor(color: string): RgbColor | null {
    const hex = color.trim().replace(/^#/, '');
    if (!/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(hex)) {
      return null;
    }

    const normalized = hex.length === 3
      ? hex.split('').map((char) => char + char).join('')
      : hex;

    return {
      r: Number.parseInt(normalized.slice(0, 2), 16),
      g: Number.parseInt(normalized.slice(2, 4), 16),
      b: Number.parseInt(normalized.slice(4, 6), 16),
    };
  }

  private parseSrgbColor(color: string): RgbColor | null {
    const match = color.match(/^color\(srgb\s+([^\s]+)\s+([^\s]+)\s+([^\s\)]+)/i);
    if (!match) {
      return null;
    }

    const [r, g, b] = match.slice(1, 4).map((component) => {
      const parsed = Number.parseFloat(component);
      if (!Number.isFinite(parsed)) {
        return null;
      }
      return this.clampColor(Math.round(parsed * 255));
    });
    if ([r, g, b].some((component) => component === null)) {
      return null;
    }

    return { r: r as number, g: g as number, b: b as number };
  }

  private parseRgbComponent(component: string): number | null {
    const trimmed = component.trim();
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return this.clampColor(Math.round(trimmed.endsWith('%') ? parsed * 2.55 : parsed));
  }

  private ensureReadableAccentColor(
    color: RgbColor,
    background: RgbColor,
    isDark: boolean,
    minContrast = 4.2,
  ): RgbColor {
    let hsl = this.rgbToHsl(color);
    let readable = color;

    for (let index = 0; index < 10; index += 1) {
      if (this.contrastRatio(readable, background) >= minContrast) {
        return readable;
      }

      hsl = {
        ...hsl,
        l: isDark
          ? Math.min(0.82, hsl.l + 0.055)
          : Math.max(0.22, hsl.l - 0.055),
      };
      readable = this.hslToRgb(hsl);
    }

    return readable;
  }

  private contrastRatio(first: RgbColor, second: RgbColor): number {
    const lighter = Math.max(this.relativeLuminance(first), this.relativeLuminance(second));
    const darker = Math.min(this.relativeLuminance(first), this.relativeLuminance(second));
    return (lighter + 0.05) / (darker + 0.05);
  }

  private relativeLuminance(color: RgbColor): number {
    const [r, g, b] = [color.r, color.g, color.b].map((component) => {
      const normalized = component / 255;
      return normalized <= 0.03928
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  private mixColors(from: RgbColor, to: RgbColor, toWeight: number): RgbColor {
    const weight = Math.max(0, Math.min(1, toWeight));
    return {
      r: this.clampColor(Math.round(from.r * (1 - weight) + to.r * weight)),
      g: this.clampColor(Math.round(from.g * (1 - weight) + to.g * weight)),
      b: this.clampColor(Math.round(from.b * (1 - weight) + to.b * weight)),
    };
  }

  private shiftAccentLightness(color: RgbColor, delta: number): RgbColor {
    const hsl = this.rgbToHsl(color);
    return this.hslToRgb({
      ...hsl,
      l: Math.max(0, Math.min(1, hsl.l + delta)),
    });
  }

  private rgbToHsl(color: RgbColor): HslColor {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) {
      return { h: 0, s: 0, l };
    }

    const delta = max - min;
    const s = l > 0.5
      ? delta / (2 - max - min)
      : delta / (max + min);
    let h = 0;

    if (max === r) {
      h = (g - b) / delta + (g < b ? 6 : 0);
    } else if (max === g) {
      h = (b - r) / delta + 2;
    } else {
      h = (r - g) / delta + 4;
    }

    return { h: h / 6, s, l };
  }

  private hslToRgb(color: HslColor): RgbColor {
    if (color.s === 0) {
      const value = this.clampColor(Math.round(color.l * 255));
      return { r: value, g: value, b: value };
    }

    const q = color.l < 0.5
      ? color.l * (1 + color.s)
      : color.l + color.s - color.l * color.s;
    const p = 2 * color.l - q;

    return {
      r: this.clampColor(Math.round(this.hueToRgb(p, q, color.h + 1 / 3) * 255)),
      g: this.clampColor(Math.round(this.hueToRgb(p, q, color.h) * 255)),
      b: this.clampColor(Math.round(this.hueToRgb(p, q, color.h - 1 / 3) * 255)),
    };
  }

  private hueToRgb(p: number, q: number, t: number): number {
    let hue = t;
    if (hue < 0) hue += 1;
    if (hue > 1) hue -= 1;
    if (hue < 1 / 6) return p + (q - p) * 6 * hue;
    if (hue < 1 / 2) return q;
    if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
    return p;
  }

  private rgbToCss(color: RgbColor): string {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  private rgbToRgba(color: RgbColor, alpha: number): string {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${Math.max(0, Math.min(1, alpha))})`;
  }

  private clampColor(value: number): number {
    return Math.max(0, Math.min(255, value));
  }

  private shouldUseTransparentTerminalBackground(): boolean {
    if (!this.options.backgroundImage || this.options.useObsidianTheme) {
      return false;
    }

    // WebGL renderer cannot show a CSS background image behind the canvas
    // reliably, so the background image is silently ignored in WebGL mode and
    // the configured backgroundColor stays in effect.
    const preferredRenderer = this.options.preferredRenderer || 'canvas';
    return preferredRenderer !== 'webgl';
  }

  private syncBackgroundLayerStyles(themeBackground = this.getTheme().background): void {
    const terminalElement = this.xterm?.element;
    if (!terminalElement) {
      return;
    }

    const useTransparentBackground = this.shouldUseTransparentTerminalBackground();
    const transparentColor = 'transparent' as const;
    const syncLayer = (layer: HTMLElement): void => {
      if (useTransparentBackground) {
        layer.style.backgroundColor = transparentColor;
        return;
      }

      // Always re-sync to the active theme so previously applied colors
      // (e.g. an old custom backgroundColor) do not leak through after
      // switching themes or appearance options. Without this, the .xterm
      // root element retains its previous inline background and shows up
      // as a frame around the cell-aligned scrollable area.
      if (layer.matches(XTERM_SCROLL_BACKGROUND_LAYER_SELECTOR)) {
        layer.style.backgroundColor = themeBackground;
      } else {
        layer.style.removeProperty('background-color');
      }
    };

    syncLayer(terminalElement);
    terminalElement.querySelectorAll<HTMLElement>(XTERM_BACKGROUND_LAYER_SELECTOR).forEach(syncLayer);
  }

  private disposeRenderer(): void {
    if (this.renderer) {
      try { this.renderer.dispose(); } catch { /* ignore */ }
      this.renderer = null;
    }
    this.rendererType = null;
  }

  private async loadRenderer(renderer: 'canvas' | 'webgl'): Promise<void> {
    await this.loadRendererInternal(renderer);
  }

  private refreshRenderer(): void {
    if (!this.containerEl) {
      return;
    }

    const resolvedRenderer = this.options.preferredRenderer || 'canvas';
    if (this.rendererType === resolvedRenderer) {
      return;
    }

    void this.loadRenderer(resolvedRenderer)
      .then(() => {
        this.updateTheme();
        this.syncBackgroundLayerStyles();
        this.fit();
        this.kittyGraphicsRenderer?.refresh();
      })
      .catch((error) => {
        errorLog('[Terminal] Renderer refresh failed:', error);
      });
  }

  private reopenTerminalElement(): void {
    const container = this.containerEl;
    if (!container) {
      return;
    }

    const activeElement = container.ownerDocument.activeElement;
    const wasFocused = activeElement instanceof Node
      && !!this.xterm.element?.contains(activeElement);

    this.disposeRenderer();
    this.disposeDomEventHandlers();
    this.xterm.element?.remove();

    try {
      if (this.xterm.element) {
        container.appendChild(this.xterm.element);
      }
      this.xterm.open(container);
      this.setupDomEventHandlers(container);
      this.syncBackgroundLayerStyles();
      this.kittyGraphicsRenderer?.refresh();
    } catch (error) {
      errorLog('[Terminal] xterm.open() failed during appearance refresh:', error);
      return;
    }

    void this.loadRenderer(this.options.preferredRenderer || 'canvas')
      .then(() => {
        this.updateTheme();
        this.syncBackgroundLayerStyles();
        this.fit();
        this.kittyGraphicsRenderer?.refresh();
        if (wasFocused) {
          this.focus();
        }
      })
      .catch((error) => {
        errorLog('[Terminal] Renderer refresh failed after terminal reopen:', error);
      });
  }

  private async loadRendererInternal(renderer: 'canvas' | 'webgl'): Promise<void> {
    if (!this.checkRendererSupport(renderer)) {
      throw new Error(t('terminalInstance.rendererNotSupported', { renderer: renderer.toUpperCase() }));
    }

    const { CanvasAddon, WebglAddon } = await loadXtermModules();

    const previousRenderer = this.rendererType;
    this.disposeRenderer();

    try {
      if (renderer === 'canvas') {
        const canvasAddon = new CanvasAddon();
        this.xterm.loadAddon(canvasAddon);
        this.renderer = canvasAddon;
        this.rendererType = 'canvas';
        if (previousRenderer !== this.rendererType) {
          this.notifyRendererChanged();
        }
        return;
      }

      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        errorLog('[Terminal] WebGL context lost, fallback to canvas renderer');
        void this.fallbackToCanvasRenderer();
      });
      this.xterm.loadAddon(webglAddon);
      this.renderer = webglAddon;
      this.rendererType = 'webgl';
      if (previousRenderer !== this.rendererType) {
        this.notifyRendererChanged();
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errorLog(`[Terminal] ${renderer} renderer failed:`, error);
      throw new Error(t('terminalInstance.rendererLoadFailed', { renderer: renderer.toUpperCase(), message: errorMsg }));
    }
  }

  private notifyRendererChanged(): void {
    if (!this.rendererType) return;
    const renderer = this.rendererType;
    this.rendererChangeCallbacks.forEach((callback) => {
      try {
        callback(renderer);
      } catch (error) {
        errorLog('[Terminal] Renderer change callback failed:', error);
      }
    });
  }

  private checkRendererSupport(renderer: 'canvas' | 'webgl'): boolean {
    try {
      const canvas = activeDocument.createElement('canvas');
      if (renderer === 'canvas') {
        return !!canvas.getContext('2d');
      }
      return !!canvas.getContext('webgl2');
    } catch {
      return false;
    }
  }

  private async fallbackToCanvasRenderer(): Promise<void> {
    try {
      await this.loadRendererInternal('canvas');
      this.fit();
    } catch (error) {
      errorLog('[Terminal] Canvas renderer fallback failed:', error);
    }
  }


  /**
   * Initialize the terminal with ServerManager
   * 

   */
  async initializeWithServerManager(serverManager: ServerManager): Promise<void> {
    if (this.isInitialized || this.isDestroyed) return;

    try {
      // Load xterm.js modules dynamically
      await this.initXterm();
      
      // Ensure the server is running
      await serverManager.ensureServer();
      
      await this.initializePtySession(serverManager, this.options.cwd);
      if (this.isDestroyed) return;
      
      this.setupXtermHandlers();
      this.isInitialized = true;
      
      debugLog('[Terminal] 终端已初始化');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errorLog('[Terminal] Init failed:', error);
      if (this.xterm) {
        this.xterm.write(`\r\n\x1b[1;31m[Error] ${errorMessage}\x1b[0m\r\n`);
      }
      throw new Error(t('terminalInstance.startFailed', { message: errorMessage }));
    }
  }

  /**
   * Set up PtyClient event handlers (session-level)
   */
  private setupPtyClientHandlers(): void {
    if (!this.ptyClient || !this.sessionId) return;
    
    // Handle output data (session-level)
    this.outputUnsubscribe = this.ptyClient.onSessionOutput(this.sessionId, (data: Uint8Array) => {
      const rawText = new TextDecoder().decode(data);
      const filteredText = filterSynchronizedOutputScrollbackPurge(
        rawText,
        this.synchronizedOutputCompatibilityState,
      );
      const terminalText = this.kittyGraphicsProtocol.transformOutput(filteredText);
      this.extractCwdFromOutput(terminalText);
      this.updateWin32InputMode(terminalText);
      this.xterm.write(terminalText);
    });
    
    // Handle exit events (session-level)
    this.exitUnsubscribe = this.ptyClient.onSessionExit(this.sessionId, (code: number) => {
      debugLog('[Terminal] PTY 会话退出, code:', code);
      this.xterm.write(`\r\n\x1b[33m[会话已结束, 退出码: ${code}]\x1b[0m\r\n`);
    });
    
    // Handle error events (session-level)
    this.errorUnsubscribe = this.ptyClient.onSessionError(this.sessionId, (code: string, message: string) => {
      errorLog('[Terminal] PTY 错误:', code, message);
      this.xterm.write(`\r\n\x1b[1;31m[错误] ${message}\x1b[0m\r\n`);
    });

    // Handle shell integration events
    this.shellEventUnsubscribe = this.ptyClient.onSessionShellEvent(this.sessionId, (event: ShellEvent) => {
      this.handleShellEvent(event);
    });

    // 前台进程变化（方案 A：用于 tab 状态检测 tmux/ssh/claude/codex）
    this.foregroundUnsubscribe = this.ptyClient.onSessionForeground(this.sessionId, (info: ForegroundInfo) => {
      this.currentForeground = info;
      this.foregroundCallback?.(info);
    });
  }

  private buildPtyConfig(cwd: string | undefined): PtyConfig {
    const terminalEnv = buildClaudeCodeTuiEnv(
      process.env,
      this.options.env,
    );

    return {
      shell_type: this.shellType === 'default' ? undefined : this.shellType,
      shell_args: this.options.shellArgs,
      cwd,
      env: terminalEnv,
      cols: this.xterm.cols,
      rows: this.xterm.rows,
    };
  }

  private async initializePtySession(serverManager: ServerManager, cwd: string | undefined): Promise<void> {
    const ptyClient = serverManager.pty();
    this.resetSessionProtocolState();
    const sessionId = await ptyClient.init(this.buildPtyConfig(cwd));
    if (this.isDestroyed) {
      ptyClient.destroySession(sessionId);
      return;
    }

    this.ptyClient = ptyClient;
    this.sessionId = sessionId;
    debugLog('[Terminal] 获取到 session_id:', this.sessionId);
    this.setupPtyClientHandlers();
  }

  private resetSessionProtocolState(): void {
    this.win32InputModeEnabled = false;
    this.claudeCodeSessionState.reset();
    this.pendingControlSequenceText = '';
    this.synchronizedOutputCompatibilityState = createSynchronizedOutputCompatibilityState();
  }

  private disposePtyClientHandlers(): void {
    this.outputUnsubscribe?.();
    this.exitUnsubscribe?.();
    this.errorUnsubscribe?.();
    this.shellEventUnsubscribe?.();
    this.foregroundUnsubscribe?.();

    this.outputUnsubscribe = null;
    this.exitUnsubscribe = null;
    this.errorUnsubscribe = null;
    this.shellEventUnsubscribe = null;
    this.foregroundUnsubscribe = null;
  }

  private hasPtyClientHandlers(): boolean {
    return this.outputUnsubscribe !== null
      || this.exitUnsubscribe !== null
      || this.errorUnsubscribe !== null
      || this.shellEventUnsubscribe !== null
      || this.foregroundUnsubscribe !== null;
  }

  private setupXtermHandlers(): void {
    const keyboardProtocol = new EnhancedKeyboardProtocol({
      queueInput: (data) => {
        this.queueInput(data);
      },
      flushPendingInput: () => {
        this.flushPendingInput();
      },
      writeBinary: (data) => {
        if (this.ptyClient && this.sessionId) {
          this.ptyClient.writeBinary(this.sessionId, data);
        }
      },
      hasSelection: () => this.xterm.hasSelection(),
      getSelection: () => this.xterm.getSelection(),
      clearSelection: () => {
        this.xterm.clearSelection();
      },
      readClipboardText: () => navigator.clipboard.readText(),
      writeClipboardText: (text) => navigator.clipboard.writeText(text),
      insertText: (text) => {
        if (text) {
          this.write(text);
        }
      },
      pasteText: (text) => {
        if (text) {
          this.pasteText(text);
        }
      },
      onError: (message, error) => {
        errorLog(`[Terminal] ${message}:`, error);
      },
    }, () => ({
      shiftEnterMode: this.win32InputModeEnabled ? 'win32-input-mode' : 'newline',
      extendedKeyboardMode: this.getClaudeCodeExtendedKeyboardMode(),
    }));

    this.xterm.onData((data) => {
      this.recordXtermInputData(data);
      keyboardProtocol.handleData(data);
    });

    this.xterm.onBinary((data) => {
      keyboardProtocol.handleBinary(data);
    });

    this.xterm.attachCustomKeyEventHandler((event: KeyboardEvent) => {
      // IME 合成中的按键绝不能被规则表按物理键码误命中：保持原放行路径。
      const legacyKeyCode = (event as unknown as { keyCode?: number }).keyCode;
      if (event.isComposing || event.key === 'Process' || legacyKeyCode === 229) {
        return keyboardProtocol.handleKeyboardEvent(event);
      }

      // Windows 输入模式有独立的按键编码，跳过通用规则表、走原有协议。
      if (this.win32InputModeEnabled) {
        return keyboardProtocol.handleKeyboardEvent(event);
      }

      // 数据驱动的键盘路由：Opt→Termy、Cmd→Obsidian(+复制粘贴)、Ctrl→程序(+黑名单)。
      const match = matchKeybinding(event, this.keybindingRules);
      if (match) {
        return this.applyKeybindingRoute(match, event);
      }

      // 未命中任何规则：交给底层协议（文本输入编码、默认透传给程序）。
      return keyboardProtocol.handleKeyboardEvent(event);
    });
  }

  private setupClaudeCodeTuiHandlers(): void {
    this.parserDisposables.push(
      this.xterm.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
        if (!this.isXtversionQuery(params)) {
          return false;
        }

        this.observeClaudeCodeXtversionQuery();
        this.write(XTVERSION_RESPONSE);
        return true;
      }),
      this.xterm.parser.registerOscHandler(52, (data) => {
        return this.handleOsc52ClipboardData(data, 'OSC 52');
      }),
      this.xterm.parser.registerOscHandler(10, (data) => {
        return this.handleDefaultColorQuery(data, 10);
      }),
      this.xterm.parser.registerOscHandler(11, (data) => {
        return this.handleDefaultColorQuery(data, 11);
      }),
      this.xterm.parser.registerOscHandler(TERMY_KITTY_GRAPHICS_OSC, (data) => {
        const result = this.kittyGraphicsProtocol.consumeMarker(data, {
          x: this.xterm.buffer.active.cursorX,
          y: this.xterm.buffer.active.cursorY,
        });
        if (result.action) {
          this.kittyGraphicsRenderer?.apply(result.action);
        }
        return result.handled;
      }),
      this.xterm.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
        if (params[0] !== 4) {
          return false;
        }

        this.observeClaudeCodeModifyOtherKeysMode(params[1] === 2);
        return true;
      }),
      this.xterm.parser.registerDcsHandler({ final: 't' }, (data) => {
        const text = decodeTmuxPassthroughOsc52Clipboard(data);
        if (text !== null) {
          this.writeClipboardFromTerminal(text, 'tmux OSC 52 passthrough');
          return true;
        }

        return false;
      }),
    );
  }

  private handleDefaultColorQuery(data: string, slot: 10 | 11): boolean {
    if (data.trim() !== '?') {
      return false;
    }

    const theme = this.getTheme();
    const color = this.colorToRgb(slot === 10 ? theme.foreground : theme.background);
    if (!color) {
      return false;
    }

    this.write(formatOscColorResponse(slot, color));
    return true;
  }

  private getClaudeCodeExtendedKeyboardMode(): ClaudeCodeExtendedKeyboardMode {
    // Keep normal terminal text input first. Claude Code's extended keyboard
    // mode can steal printable IME keys, so leave it disabled at runtime until
    // it can be reintroduced without interfering with composition.
    return 'none';
  }

  private observeClaudeCodeXtversionQuery(): void {
    this.claudeCodeSessionState.observeXtversionQuery();
    this.applyTitleChange(this.titleState.setAutomaticTitle('Claude Code'));
  }

  private observeClaudeCodeModifyOtherKeysMode(enabled: boolean): void {
    this.claudeCodeSessionState.observeModifyOtherKeysMode(enabled);
    this.applyTitleChange(
      enabled
        ? this.titleState.setAutomaticTitle('Claude Code')
        : this.titleState.clearAutomaticTitle()
    );
  }

  private observeShellPrompt(): void {
    this.claudeCodeSessionState.observeShellPrompt();
    this.applyTitleChange(this.titleState.clearAutomaticTitle());
  }

  private applyTitleChange(changed: boolean): void {
    if (changed) {
      const title = this.titleState.getTitle();
      this.titleChangeCallbacks.forEach((callback) => callback(title));
    }
  }

  private isXtversionQuery(params: (number | number[])[]): boolean {
    const firstParam = params[0];
    return firstParam === undefined || firstParam === 0;
  }

  private handleOsc52ClipboardData(data: string, source: string): boolean {
    const text = decodeOsc52Clipboard(data);
    if (text === null) {
      return false;
    }

    this.writeClipboardFromTerminal(text, source);
    return true;
  }

  private writeClipboardFromTerminal(text: string, source: string): void {
    if (!navigator.clipboard?.writeText) {
      debugWarn(`[Terminal] ${source} clipboard write is unavailable`);
      return;
    }

    void navigator.clipboard.writeText(text).catch((error) => {
      errorLog(`[Terminal] ${source} clipboard write failed:`, error);
    });
  }

  private queueInput(data: string): void {
    if (this.isDestroyed) return;
    this.pendingInput.push(data);

    if (this.inputFlushTimer === null) {
      this.inputFlushTimer = window.setTimeout(() => {
        this.flushPendingInput();
      }, this.inputBatchIntervalMs);
    }
  }

  private clearPendingInput(): void {
    if (this.inputFlushTimer !== null) {
      window.clearTimeout(this.inputFlushTimer);
      this.inputFlushTimer = null;
    }
    this.pendingInput = [];
    this.clearImeCommitFallback();
  }

  private clearImeCommitFallback(): void {
    if (this.pendingImeCommitFallbackTimer !== null) {
      window.clearTimeout(this.pendingImeCommitFallbackTimer);
      this.pendingImeCommitFallbackTimer = null;
    }
    this.pendingImeCommitFallbackText = '';
  }

  private recordXtermInputData(data: string): void {
    this.lastXtermInputData = data;
    this.lastXtermInputDataAt = Date.now();

    if (
      this.pendingImeCommitFallbackText
      && data.includes(this.pendingImeCommitFallbackText)
    ) {
      this.clearImeCommitFallback();
    }
  }

  private hasRecentlySeenXtermInputData(text: string): boolean {
    return Date.now() - this.lastXtermInputDataAt <= IME_COMMIT_RECENT_DATA_WINDOW_MS
      && this.lastXtermInputData.includes(text);
  }

  private scheduleImeCommitFallback(text: string | null | undefined): void {
    if (!isImeCommitFallbackText(text)) {
      return;
    }

    if (this.hasRecentlySeenXtermInputData(text)) {
      return;
    }

    this.clearImeCommitFallback();
    this.pendingImeCommitFallbackText = text;
    this.pendingImeCommitFallbackTimer = window.setTimeout(() => {
      const pendingText = this.pendingImeCommitFallbackText;
      this.pendingImeCommitFallbackTimer = null;
      this.pendingImeCommitFallbackText = '';

      if (
        this.isDestroyed
        || !isImeCommitFallbackText(pendingText)
        || this.hasRecentlySeenXtermInputData(pendingText)
      ) {
        return;
      }

      this.queueInput(pendingText);
      this.flushPendingInput();
    }, IME_COMMIT_FALLBACK_DELAY_MS);
  }

  private flushPendingInput(): void {
    if (this.pendingInput.length === 0) {
      this.inputFlushTimer = null;
      return;
    }

    const merged = this.pendingInput.join('');
    this.pendingInput = [];
    this.inputFlushTimer = null;

    if (this.ptyClient && this.sessionId) {
      this.ptyClient.write(this.sessionId, merged);
    }
  }

  private updateWin32InputMode(data: string): void {
    if (!isWindows()) {
      return;
    }

    const buffer = `${this.pendingControlSequenceText}${data}`;
    // eslint-disable-next-line no-control-regex -- Need to match ANSI control sequences
    const modeRegex = /\x1b\[\?9001([hl])/g;
    let match: RegExpExecArray | null = null;
    while ((match = modeRegex.exec(buffer)) !== null) {
      this.win32InputModeEnabled = match[1] === 'h';
    }

    this.pendingControlSequenceText = buffer.slice(-32);
  }

  /**
   * Send a resize message
   */
  private sendResize(cols: number, rows: number): void {
    if (this.ptyClient && this.sessionId) {
      this.ptyClient.resize(this.sessionId, cols, rows);
    }
  }

  fit(): void {
    if (!this.containerEl) return;

    try {
      const { clientWidth, clientHeight } = this.containerEl;
      if (clientWidth === 0 || clientHeight === 0) return;

      this.fitAddon.fit();
      this.sendResize(this.xterm.cols, this.xterm.rows);
      this.kittyGraphicsRenderer?.refresh();
    } catch (error) {
      debugWarn('[Terminal] Fit failed:', error);
    }
  }

  handleServerCrash(): void {
    if (this.isDestroyed) return;

    this.webSocketDisconnected = false;
    this.sessionRecoveryNeeded = true;
    this.clearPendingInput();
    this.xterm.write('\r\n\x1b[1;31m[服务器已崩溃]\x1b[0m\r\n');
    this.xterm.write('\x1b[33m正在尝试重启服务器...\x1b[0m\r\n');
  }

  handleWebSocketDisconnected(): void {
    if (this.isDestroyed) return;

    this.sessionRecoveryNeeded = true;
    this.clearPendingInput();
    if (this.webSocketDisconnected) return;
    this.webSocketDisconnected = true;
    this.xterm.write('\r\n\x1b[33m[WebSocket 连接已断开，正在重连...]\x1b[0m\r\n');
  }

  async handleWebSocketConnected(serverManager: ServerManager): Promise<void> {
    if (
      this.isDestroyed
      || this.sessionRecoveryInProgress
      || !this.sessionRecoveryNeeded
    ) {
      return;
    }

    this.sessionRecoveryInProgress = true;
    this.xterm.write('\x1b[32m[连接已恢复，正在恢复终端会话...]\x1b[0m\r\n');

    try {
      this.clearPendingInput();

      let attachedExistingSession = false;
      const existingSessionId = this.sessionId;
      if (existingSessionId) {
        try {
          const ptyClient = serverManager.pty();
          attachedExistingSession = await ptyClient.attach(existingSessionId);
          if (attachedExistingSession) {
            if (this.ptyClient !== ptyClient || !this.hasPtyClientHandlers()) {
              this.disposePtyClientHandlers();
              this.ptyClient = ptyClient;
              this.sessionId = existingSessionId;
              this.setupPtyClientHandlers();
            } else {
              this.ptyClient = ptyClient;
              this.sessionId = existingSessionId;
            }
          }
        } catch (error) {
          debugWarn('[Terminal] 重新绑定现有 PTY 会话失败，将尝试创建新会话:', error);
        }
      }

      if (!attachedExistingSession) {
        this.disposePtyClientHandlers();
        this.sessionId = null;

        const reconnectCwd = this.currentCwd ?? this.options.cwd;
        try {
          await this.initializePtySession(serverManager, reconnectCwd);
        } catch (error) {
          if (!this.currentCwd || this.currentCwd === this.options.cwd) {
            throw error;
          }

          debugWarn('[Terminal] 使用当前目录恢复会话失败，回退到初始目录:', error);
          await this.initializePtySession(serverManager, this.options.cwd);
        }
      }
      if (this.isDestroyed) return;

      this.sessionRecoveryNeeded = false;
      this.webSocketDisconnected = false;
      this.xterm.write(
        attachedExistingSession
          ? '\x1b[32m[终端会话已重新连接]\x1b[0m\r\n'
          : '\x1b[32m[终端会话已重新创建]\x1b[0m\r\n'
      );
      this.fit();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      errorLog('[Terminal] 恢复终端会话失败:', error);
      this.sessionRecoveryNeeded = true;
      this.webSocketDisconnected = true;
      this.xterm.write(`\x1b[1;31m[终端会话恢复失败] ${errorMessage}\x1b[0m\r\n`);
    } finally {
      this.sessionRecoveryInProgress = false;
    }
  }

  destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.clearPendingInput();
    this.kittyGraphicsProtocol.reset();
    this.kittyGraphicsRenderer?.dispose();
    this.kittyGraphicsRenderer = null;
    this.promptMarkers = [];
    this.commandMarkers = [];

    // Unsubscribe from events
    this.disposePtyClientHandlers();
    for (const disposable of this.parserDisposables) {
      try { disposable.dispose(); } catch { /* ignore */ }
    }
    this.parserDisposables = [];

    // Destroy the PTY session
    if (this.ptyClient && this.sessionId) {
      this.ptyClient.destroySession(this.sessionId);
    }

    this.detach();

    if (this.renderer) {
      try { this.renderer.dispose(); } catch { /* ignore */ }
      this.renderer = null;
    }
    this.rendererType = null;

    // Clear references
    this.ptyClient = null;
    this.sessionId = null;

    // 清空所有回调登记，避免销毁后仍强引用外部（view 层）回调而阻止 GC。
    this.titleChangeCallbacks.clear();
    this.searchStateCallbacks.clear();
    this.fontSizeChangeCallbacks.clear();
    this.rendererChangeCallbacks.clear();
    this.contextMenuCallbacks = {};
    this.shellEventCallback = null;
    this.foregroundCallback = null;
    this.tabNavCallback = null;

    try { this.xterm.dispose(); } catch { /* ignore */ }
  }

  attachToElement(container: HTMLElement): void {
    if (this.isDestroyed) {
      throw new Error(t('terminalInstance.instanceDestroyed'));
    }

    const containerWindow = container.ownerDocument.defaultView ?? window;
    if (
      this.containerEl === container
      && this.xterm.element?.parentElement === container
      && this.hostWindow === containerWindow
    ) {
      return;
    }

    this.detach();
    this.containerEl = container;
    this.hostWindow = containerWindow;

    try {
      if (this.xterm.element) {
        container.appendChild(this.xterm.element);
      }
      this.xterm.open(container);
      this.syncBackgroundLayerStyles();
      this.kittyGraphicsRenderer?.refresh();
    } catch (error) {
      errorLog('[Terminal] xterm.open() failed:', error);
      throw error;
    }

    // Set up the context menu and keyboard shortcuts
    this.setupDomEventHandlers(container);

    const preferredRenderer = this.options.preferredRenderer || 'canvas';

    // Load the renderer asynchronously
    window.requestAnimationFrame(() => {
      void this.loadRenderer(preferredRenderer)
        .then(() => {
          this.syncBackgroundLayerStyles();
          this.fit();
          this.kittyGraphicsRenderer?.refresh();
        })
        .catch((error) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.xterm.write(`\r\n\x1b[1;31m[渲染器错误] ${errorMsg}\x1b[0m\r\n`);
        });
    });
  }

  /**
   * Set up keyboard shortcuts
   */
  private setupDomEventHandlers(container: HTMLElement): void {
    this.disposeDomEventHandlers();
    this.setupImeCommitFallback(container);
    this.setupKeyboardShortcuts(container);
    this.setupContextMenu(container);
  }

  private addDomEventListener<K extends keyof HTMLElementEventMap>(
    container: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    container.addEventListener(type, listener, options);
    this.domEventCleanups.push(() => {
      container.removeEventListener(type, listener, options);
    });
  }

  private disposeDomEventHandlers(): void {
    this.clearImeCommitFallback();

    for (const cleanup of this.domEventCleanups.splice(0)) {
      cleanup();
    }
  }

  private setupImeCommitFallback(container: HTMLElement): void {
    const textarea = container.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    if (!textarea) {
      return;
    }
    const screen = container.querySelector<HTMLElement>('.xterm-screen');
    const compositionOverlay = screen ? this.ensureImeCompositionOverlay(screen) : null;
    const syncCompositionOverlay = (text?: string | null): void => {
      if (!compositionOverlay || !screen) {
        return;
      }
      this.scheduleImeCompositionOverlaySync(compositionOverlay, textarea, screen, text);
    };

    this.isComposing = false;

    // 跟踪合成态：流式语音输入法会在 compositionstart..compositionend 之间不断发出
    // insertCompositionText 中间结果（已是中文，能通过 isImeCommitFallbackText），
    // 这些中间态绝不能逐段补发——否则会在 PTY 里一段段 append 而非替换。最终提交只
    // 认 compositionend 一次。
    this.addDomEventListener(textarea, 'compositionstart', () => {
      this.isComposing = true;
      this.setImeComposingClass(container, true);
      if (compositionOverlay) {
        compositionOverlay.textContent = '';
        compositionOverlay.classList.add('active');
      }
      syncCompositionOverlay();
    });
    this.addDomEventListener(textarea, 'compositionupdate', (event: CompositionEvent) => {
      syncCompositionOverlay(event.data);
    });
    this.addDomEventListener(textarea, 'compositionend', (event: CompositionEvent) => {
      this.isComposing = false;
      this.setImeComposingClass(container, false);
      if (compositionOverlay) {
        this.hideImeCompositionOverlay(compositionOverlay);
      }
      this.scheduleImeCommitFallback(event.data);
    });
    this.addDomEventListener(textarea, 'beforeinput', (event: InputEvent) => {
      if (this.isComposing) {
        const text = event.inputType === 'insertCompositionText' ? event.data : undefined;
        syncCompositionOverlay(text);
      }
      if (shouldScheduleImeCommitFallbackForBeforeInput(event, this.isComposing)) {
        this.scheduleImeCommitFallback(event.data);
      }
    });
  }

  private ensureImeCompositionOverlay(screen: HTMLElement): HTMLElement {
    const existing = screen.querySelector<HTMLElement>(':scope > .termy-ime-composition-view');
    if (existing) {
      return existing;
    }

    const overlay = screen.ownerDocument.createElement('div');
    overlay.className = 'termy-ime-composition-view';
    screen.appendChild(overlay);
    return overlay;
  }

  private setImeComposingClass(container: HTMLElement, active: boolean): void {
    container.querySelector<HTMLElement>('.xterm')?.classList.toggle('is-ime-composing', active);
  }

  private scheduleImeCompositionOverlaySync(
    overlay: HTMLElement,
    textarea: HTMLTextAreaElement,
    screen: HTMLElement,
    text?: string | null,
  ): void {
    this.syncImeCompositionOverlay(overlay, textarea, screen, text);

    const hostWindow = overlay.ownerDocument.defaultView ?? window;
    hostWindow.requestAnimationFrame(() => {
      this.syncImeCompositionOverlay(overlay, textarea, screen);
    });
    hostWindow.setTimeout(() => {
      this.syncImeCompositionOverlay(overlay, textarea, screen);
    }, 0);
  }

  private syncImeCompositionOverlay(
    overlay: HTMLElement,
    textarea: HTMLTextAreaElement,
    screen: HTMLElement,
    text?: string | null,
  ): void {
    if (this.isDestroyed || !this.isComposing) {
      return;
    }

    if (text !== undefined && text !== null) {
      overlay.textContent = text;
    }
    overlay.classList.toggle('active', !!overlay.textContent);

    const cellHeight = this.getImeCompositionCellHeight(screen);
    const cursorLeft = parsePixelValue(textarea.style.left);
    const cursorTop = parsePixelValue(textarea.style.top);
    overlay.style.lineHeight = `${cellHeight}px`;
    overlay.style.fontFamily = String(this.xterm.options.fontFamily ?? '');
    overlay.style.fontSize = `${this.xterm.options.fontSize ?? this.currentFontSize}px`;

    const measuredHeight = Math.max(cellHeight, overlay.scrollHeight || overlay.offsetHeight || cellHeight);
    const layout = computeImeCompositionViewLayout({
      screenWidth: screen.clientWidth,
      screenHeight: screen.clientHeight,
      cursorLeft,
      cursorTop,
      cellHeight,
      contentHeight: measuredHeight,
    });

    overlay.style.left = `${layout.left}px`;
    overlay.style.top = `${layout.top}px`;
    overlay.style.width = `${layout.width}px`;
    overlay.style.maxWidth = `${layout.width}px`;
    overlay.style.maxHeight = `${layout.maxHeight}px`;
    overlay.style.textIndent = `${layout.textIndent}px`;
    overlay.scrollTop = overlay.scrollHeight;
  }

  private hideImeCompositionOverlay(overlay: HTMLElement): void {
    overlay.classList.remove('active');
    overlay.textContent = '';
    overlay.removeAttribute('style');
  }

  private getImeCompositionCellHeight(screen: HTMLElement): number {
    const renderDims = (this.xterm as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } };
    })._core?._renderService?.dimensions?.css?.cell;
    return renderDims?.height
      || (this.xterm.rows > 0 ? screen.clientHeight / this.xterm.rows : 0)
      || parsePixelValue(this.xterm.element?.querySelector<HTMLElement>('.xterm-helper-textarea')?.style.lineHeight ?? '')
      || 1;
  }

  private setupKeyboardShortcuts(container: HTMLElement): void {
    // 搜索 / 字体 / 全选等快捷键已统一交给键盘路由表（见 attachCustomKeyEventHandler 里的
    // matchKeybinding）。这里只保留「搜索框可见时按 Esc 关闭」这个搜索 UI 的局部行为；
    // 其余 Esc 照常透传给程序（vim/claude 的 Esc 不受影响）。
    this.addDomEventListener(container, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.searchVisible) {
        e.preventDefault();
        this.hideSearch();
      }
    });

    // Ctrl+wheel: 字体缩放手势（Cmd+滚轮不再缩放，交回宿主）。
    this.addDomEventListener(container, 'wheel', (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          this.increaseFontSize();
        } else {
          this.decreaseFontSize();
        }
      }
    }, { passive: false });
  }

  /**
   * Set up the terminal context menu
   */
  private setupContextMenu(container: HTMLElement): void {
    this.addDomEventListener(container, 'contextmenu', (e: MouseEvent) => {
      const action = resolveTerminalContextMenuAction({
        isClaudeCodeSession: this.isClaudeCodeSession(),
        event: e,
      });

      // Either way Termy stops the host (browser / Obsidian) from also
      // popping its own context menu on this gesture.
      e.preventDefault();
      e.stopPropagation();

      if (action === 'suppress') {
        // Claude Code's TUI already handles right-click as paste through
        // xterm.js mouse tracking. Termy must not also paste here, otherwise
        // the clipboard contents land in the terminal twice.
        return;
      }

      // Calculate the terminal row/column coordinates for the mouse click
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      // Calculate coordinates using xterm.js sizing assumptions
      const coords = this.getTerminalCoordinates(x, y);

      this.showContextMenu(container, e.clientX, e.clientY, coords);
    });
  }


  /**
   * Show the context menu
   */
  private showContextMenu(
    host: HTMLElement,
    x: number,
    y: number,
    coords?: { col: number; row: number }
  ): void {
    const menuDocument = host.ownerDocument;
    const menuWindow = menuDocument.defaultView ?? window;

    // Remove any existing menu
    const existingMenu = menuDocument.querySelector('.terminal-context-menu');
    if (existingMenu) {
      existingMenu.remove();
    }

    const menu = menuDocument.createElement('div');
    menu.className = 'terminal-context-menu';
    menu.setCssStyles({ left: `${x}px`, top: `${y}px` });

    const hasSelection = this.xterm.hasSelection();
    const selectedText = hasSelection ? this.xterm.getSelection() : '';

    // Copy
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.copy'),
      'copy',
      hasSelection,
      () => {
        if (!selectedText) return;
        void this.writeToClipboard(selectedText, () => {
          this.xterm.clearSelection();
        });
      },
      'Ctrl+Shift+C'
    ));

    // Copy as plain text (strip ANSI escape sequences)
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.copyAsPlainText'),
      'file-text',
      hasSelection,
      () => {
        if (!selectedText) return;
        const plainText = this.stripAnsiCodes(selectedText);
        void this.writeToClipboard(plainText, () => {
          this.xterm.clearSelection();
        });
      }
    ));

    // Paste
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.paste'),
      'clipboard-paste',
      true,
      () => {
        void this.pasteFromClipboard();
      },
      'Ctrl+Shift+V'
    ));

    menu.appendChild(this.createSeparator(menuDocument));

    // Select all content
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.selectAll'),
      'select-all',
      true,
      () => this.xterm.selectAll(),
      'Ctrl+Shift+A'
    ));

    // Select the current line
    if (coords) {
      menu.appendChild(this.createMenuItem(
        menuDocument,
        t('terminal.contextMenu.selectLine'),
        'minus',
        true,
        () => this.selectLine(coords.row)
      ));
    }

    // Search
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.search'),
      'search',
      true,
      () => this.toggleSearch(),
      'Ctrl+F'
    ));

    menu.appendChild(this.createSeparator(menuDocument));

    // Copy the current path
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.copyPath'),
      'folder',
      true,
      () => {
        const cwd = this.getCwd();
        void this.writeToClipboard(cwd);
      }
    ));

    // Open in the file manager
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.openInExplorer'),
      'folder-open',
      true,
      () => {
        const cwd = this.getCwd();
        this.openInFileManager(cwd);
      }
    ));

    menu.appendChild(this.createSeparator(menuDocument));

    // New terminal
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.newTerminal'),
      'terminal',
      true,
      () => this.contextMenuCallbacks.onNewTerminal?.(),
      'Ctrl+O'
    ));

    const defaultShellOptions = this.contextMenuCallbacks.getDefaultShellOptions?.() ?? [];
    if (defaultShellOptions.length > 0 && this.contextMenuCallbacks.onDefaultShellChange) {
      menu.appendChild(this.createSubmenuItem(
        menuDocument,
        menuWindow,
        t('terminal.contextMenu.switchDefaultTerminal'),
        'terminal',
        defaultShellOptions.map((option) => ({
          label: option.label,
          icon: option.selected ? 'check' : 'blank',
          onClick: () => this.contextMenuCallbacks.onDefaultShellChange?.(option.shellType),
        }))
      ));
    }

    menu.appendChild(this.createSeparator(menuDocument));

    // Font size submenu
    const fontSubmenu = this.createSubmenuItem(
      menuDocument,
      menuWindow,
      t('terminal.contextMenu.fontSize'),
      'type',
      [
        {
          label: t('terminal.contextMenu.fontIncrease'),
          icon: 'plus',
          onClick: () => this.increaseFontSize(),
          shortcut: 'Ctrl+='
        },
        {
          label: t('terminal.contextMenu.fontDecrease'),
          icon: 'minus',
          onClick: () => this.decreaseFontSize(),
          shortcut: 'Ctrl+-'
        },
        {
          label: t('terminal.contextMenu.fontReset'),
          icon: 'rotate-ccw',
          onClick: () => this.resetFontSize(),
          shortcut: 'Ctrl+0'
        }
      ]
    );
    menu.appendChild(fontSubmenu);

    // Clear the screen
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.clear'),
      'trash',
      true,
      () => this.clearScreen(),
      'Ctrl+Shift+R'
    ));

    // Clear the buffer
    menu.appendChild(this.createMenuItem(
      menuDocument,
      t('terminal.contextMenu.clearBuffer'),
      'trash',
      true,
      () => this.clearBuffer(),
      'Ctrl+Shift+K'
    ));

    menuDocument.body.appendChild(menu);

    // Adjust the menu position
    const rect = menu.getBoundingClientRect();
    if (rect.right > menuWindow.innerWidth) {
      menu.setCssStyles({ left: `${menuWindow.innerWidth - rect.width - 5}px` });
    }
    if (rect.bottom > menuWindow.innerHeight) {
      menu.setCssStyles({ top: `${menuWindow.innerHeight - rect.height - 5}px` });
    }

    // Close the menu when clicking elsewhere
    const closeMenu = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        menuDocument.removeEventListener('click', closeMenu);
        menuDocument.removeEventListener('contextmenu', closeMenu);
      }
    };

    window.setTimeout(() => {
      menuDocument.addEventListener('click', closeMenu);
      menuDocument.addEventListener('contextmenu', closeMenu);
    }, 0);
  }

  private async writeToClipboard(text: string, onSuccess?: () => void): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      onSuccess?.();
    } catch (error) {
      errorLog('[Terminal] Clipboard write failed:', error);
    }
  }

  /**
   * Create a menu item
   */
  private createMenuItem(
    menuDocument: Document,
    label: string,
    icon: string,
    enabled: boolean,
    onClick: () => void,
    shortcut?: string
  ): HTMLElement {
    const item = menuDocument.createElement('div');
    item.className = 'terminal-context-menu-item';
    if (!enabled) item.addClass('is-disabled');

    // Icon
    const iconEl = menuDocument.createElement('span');
    iconEl.className = 'terminal-context-menu-icon';
    if (!enabled) iconEl.addClass('is-disabled');
    const iconSvg = this.createIconElement(menuDocument, icon);
    if (iconSvg) iconEl.appendChild(iconSvg);
    item.appendChild(iconEl);

    // Text
    const textEl = menuDocument.createElement('span');
    textEl.textContent = label;
    textEl.className = 'terminal-context-menu-text';
    item.appendChild(textEl);

    // Shortcut
    if (shortcut) {
      const shortcutEl = menuDocument.createElement('span');
      shortcutEl.textContent = shortcut;
      shortcutEl.className = 'terminal-context-menu-shortcut';
      item.appendChild(shortcutEl);
    }

    if (enabled) {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        onClick();
        menuDocument.querySelector('.terminal-context-menu')?.remove();
      });
    }

    return item;
  }

  /**
   * Create a submenu item
   */
  private createSubmenuItem(
    menuDocument: Document,
    menuWindow: Window,
    label: string,
    icon: string,
    items: Array<{ label: string; icon: string; onClick: () => void; shortcut?: string }>
  ): HTMLElement {
    const container = menuDocument.createElement('div');
    container.className = 'terminal-context-submenu-container';

    const item = menuDocument.createElement('div');
    item.className = 'terminal-context-menu-item';

    // Icon
    const iconEl = menuDocument.createElement('span');
    iconEl.className = 'terminal-context-menu-icon';
    const iconSvg = this.createIconElement(menuDocument, icon);
    if (iconSvg) iconEl.appendChild(iconSvg);
    item.appendChild(iconEl);

    // Text
    const textEl = menuDocument.createElement('span');
    textEl.textContent = label;
    textEl.className = 'terminal-context-menu-text';
    item.appendChild(textEl);

    // Arrow
    const arrowEl = menuDocument.createElement('span');
    arrowEl.className = 'terminal-context-submenu-arrow';
    const arrowSvg = this.createIconElement(menuDocument, 'chevron-right');
    if (arrowSvg) arrowEl.appendChild(arrowSvg);
    item.appendChild(arrowEl);

    container.appendChild(item);

    // Submenu
    const submenu = menuDocument.createElement('div');
    submenu.className = 'terminal-context-submenu';

    items.forEach(subItem => {
      submenu.appendChild(this.createMenuItem(menuDocument, subItem.label, subItem.icon, true, subItem.onClick, subItem.shortcut));
    });

    container.appendChild(submenu);

    // Show the submenu on hover
    item.addEventListener('mouseenter', () => {
      submenu.addClass('is-visible');
      submenu.removeClass('is-flipped');
      const submenuTopReset = '0';
      submenu.style.top = submenuTopReset;

      // Adjust the submenu position
      const rect = submenu.getBoundingClientRect();
      if (rect.right > menuWindow.innerWidth) {
        submenu.addClass('is-flipped');
      }

      const adjustedRect = submenu.getBoundingClientRect();
      if (adjustedRect.bottom > menuWindow.innerHeight) {
        const topOffset = Math.min(0, menuWindow.innerHeight - adjustedRect.bottom - 8);
        submenu.style.top = `${topOffset}px`;
      }
    });

    container.addEventListener('mouseleave', () => {
      submenu.removeClass('is-visible');
    });

    return container;
  }

  /**
   * Create a separator
   */
  private createSeparator(menuDocument: Document): HTMLElement {
    const separator = menuDocument.createElement('div');
    separator.className = 'terminal-context-separator';
    return separator;
  }

  /**
   * Strip ANSI escape sequences
   */
  private stripAnsiCodes(text: string): string {
    // eslint-disable-next-line no-control-regex -- Need to match ANSI control sequences
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }


  /**
   * Get the icon SVG
   */
  private getIconSvg(icon: string): string {
    const icons: Record<string, string> = {
      'copy': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
      'clipboard-paste': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H9a1 1 0 0 0-1 1v2c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V3c0-.6-.4-1-1-1Z"></path><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2M16 4h2a2 2 0 0 1 2 2v2M11 14h10"></path><path d="m17 10 4 4-4 4"></path></svg>',
      'select-all': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M9 3v18"></path><path d="M15 3v18"></path><path d="M3 9h18"></path><path d="M3 15h18"></path></svg>',
      'trash': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>',
      'search': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>',
      'folder': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path></svg>',
      'folder-open': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"></path></svg>',
      'terminal': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" x2="20" y1="19" y2="19"></line></svg>',
      'lock': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
      'columns': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><line x1="12" x2="12" y1="3" y2="21"></line></svg>',
      'separator-horizontal': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" x2="21" y1="12" y2="12"></line><polyline points="8 8 12 4 16 8"></polyline><polyline points="16 16 12 20 8 16"></polyline></svg>',
      'separator-vertical': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" x2="12" y1="3" y2="21"></line><polyline points="8 8 4 12 8 16"></polyline><polyline points="16 16 20 12 16 8"></polyline></svg>',
      'type': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"></polyline><line x1="9" x2="15" y1="20" y2="20"></line><line x1="12" x2="12" y1="4" y2="20"></line></svg>',
      'plus': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="M12 5v14"></path></svg>',
      'minus': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path></svg>',
      'rotate-ccw': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>',
      'chevron-right': '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"></path></svg>',
      'file-text': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" x2="8" y1="13" y2="13"></line><line x1="16" x2="8" y1="17" y2="17"></line><line x1="10" x2="8" y1="9" y2="9"></line></svg>',
      'chevron-up': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"></path></svg>',
      'chevron-down': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>',
      'x': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',
      'check': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>',
      'blank': '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"></svg>',
    };
    return icons[icon] || '';
  }

  private createIconElement(menuDocument: Document, icon: string): SVGElement | null {
    const svgText = this.getIconSvg(icon);
    if (!svgText) return null;
    const DOMParserCtor = menuDocument.defaultView?.DOMParser ?? DOMParser;
    const parsed = new DOMParserCtor().parseFromString(svgText, 'image/svg+xml');
    const svg = parsed.querySelector('svg');
    return svg ? menuDocument.importNode(svg, true) : null;
  }

  // ==================== Search ====================

  /**
   * Toggle search bar visibility
   */
  toggleSearch(): void {
    if (this.searchVisible) {
      this.hideSearch();
    } else {
      this.showSearch();
    }
  }

  /**
   * Show the search bar
   */
  showSearch(): void {
    this.searchVisible = true;
    this.searchStateCallbacks.forEach((callback) => callback(true));
  }

  /**
   * Hide the search bar
   */
  hideSearch(): void {
    this.searchVisible = false;
    this.searchAddon.clearDecorations();
    this.searchStateCallbacks.forEach((callback) => callback(false));
    this.focus();
  }

  /**
   * Search text
   */
  search(query: string, options?: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean }): boolean {
    if (!query) {
      this.searchAddon.clearDecorations();
      return false;
    }
    this.lastSearchQuery = query;
    
    // Use the current theme colors for search highlighting
    const isDark = activeDocument.body.classList.contains('theme-dark');
    
    return this.searchAddon.findNext(query, {
      caseSensitive: options?.caseSensitive ?? false,
      wholeWord: options?.wholeWord ?? false,
      regex: options?.regex ?? false,
      decorations: {
        matchBackground: isDark ? '#5a5a00' : '#ffff00',
        activeMatchBackground: isDark ? '#806000' : '#ff9900',
        matchOverviewRuler: isDark ? '#888800' : '#ffff00',
        activeMatchColorOverviewRuler: isDark ? '#aa6600' : '#ff9900',
      }
    });
  }

  /**
   * Search next
   */
  searchNext(): boolean {
    if (!this.lastSearchQuery) return false;
    return this.searchAddon.findNext(this.lastSearchQuery);
  }

  /**
   * Search previous
   */
  searchPrevious(): boolean {
    if (!this.lastSearchQuery) return false;
    return this.searchAddon.findPrevious(this.lastSearchQuery);
  }

  /**
   * Clear search highlighting
   */
  clearSearch(): void {
    this.searchAddon.clearDecorations();
    this.lastSearchQuery = '';
  }

  /**
   * Listen for search state changes
   */
  onSearchStateChange(callback: SearchStateCallback): () => void {
    this.searchStateCallbacks.add(callback);
    return () => {
      this.searchStateCallbacks.delete(callback);
    };
  }

  /**
   * Get whether the search UI is visible
   */
  isSearchVisible(): boolean {
    return this.searchVisible;
  }

  // ==================== Shell Integration ====================

  private handleShellEvent(event: ShellEvent): void {
    if (event.type === 'prompt_start') {
      this.observeShellPrompt();
      this.promptMarkers.push(this.xterm.registerMarker(0));
    }

    if (event.type === 'command_start') {
      this.activeCommandStart = Date.now();
    }

    if (event.type === 'command_end') {
      const endTime = Date.now();
      const startTime = this.activeCommandStart ?? endTime;
      const durationMs = Math.max(0, endTime - startTime);
      this.commandHistory.push({
        startTime,
        endTime,
        durationMs,
        exitCode: event.exitCode,
        source: event.source,
      });
      this.commandMarkers.push({
        marker: this.xterm.registerMarker(0),
        exitCode: event.exitCode,
      });
      this.activeCommandStart = null;
    }

    this.shellEventCallback?.(event);
  }

  /**
   * Listen for shell integration events
   */
  onShellEvent(callback: (event: ShellEvent) => void): void {
    this.shellEventCallback = callback;
  }

  /** 注册前台进程变化回调（方案 A）；注册时立即回放当前状态 */
  onForegroundChange(callback: (info: ForegroundInfo) => void): void {
    this.foregroundCallback = callback;
    if (this.currentForeground) {
      callback(this.currentForeground);
    }
  }

  getForeground(): ForegroundInfo | null {
    return this.currentForeground;
  }

  /**
   * Get command history
   */
  getCommandHistory(): Array<{
    startTime: number;
    endTime: number;
    durationMs: number;
    exitCode: number | null;
    source: ShellEventSource;
  }> {
    return [...this.commandHistory];
  }

  // ==================== Font Size Adjustment ====================

  /**
   * Increase font size
   */
  increaseFontSize(): void {
    if (this.currentFontSize < this.maxFontSize) {
      this.setFontSize(this.currentFontSize + 1);
    }
  }

  /**
   * Decrease font size
   */
  decreaseFontSize(): void {
    if (this.currentFontSize > this.minFontSize) {
      this.setFontSize(this.currentFontSize - 1);
    }
  }

  /**
   * Reset font size
   */
  resetFontSize(): void {
    this.setFontSize(this.options.fontSize ?? 14);
  }

  /**
   * Set font size
   */
  setFontSize(size: number): void {
    const newSize = Math.max(this.minFontSize, Math.min(this.maxFontSize, size));
    if (newSize !== this.currentFontSize) {
      this.currentFontSize = newSize;
      this.xterm.options.fontSize = newSize;
      this.fit();
      this.fontSizeChangeCallbacks.forEach((callback) => callback(newSize));
    }
  }

  /**
   * Get the current font size
   */
  getFontSize(): number {
    return this.currentFontSize;
  }

  /**
   * Listen for font size changes
   */
  onFontSizeChange(callback: FontSizeChangeCallback): () => void {
    this.fontSizeChangeCallbacks.add(callback);
    return () => {
      this.fontSizeChangeCallbacks.delete(callback);
    };
  }

  // ==================== Context Menu Callback Setup ====================

  /**
   * Set the new terminal callback
   */
  setOnNewTerminal(callback: () => void): void {
    this.contextMenuCallbacks.onNewTerminal = callback;
  }

  private tabNavCallback: ((action: TermyTabNavAction) => void) | null = null;

  setTabNavCallback(callback: ((action: TermyTabNavAction) => void) | null): void {
    this.tabNavCallback = callback;
  }

  /**
   * Match Opt tab navigation keys using physical key codes.
   */
  /**
   * 执行一条键盘路由结果。返回值遵循 xterm attachCustomKeyEventHandler 约定：
   * true = 让 xterm 编码并发给程序；false = xterm 不处理这个键。
   */
  private applyKeybindingRoute(match: KeybindingMatch, event: KeyboardEvent): boolean {
    switch (match.route) {
      case 'terminal':
        // 透传给终端里的程序（Ctrl 行编辑、中断、Ctrl+V 图片粘贴等）。
        return true;
      case 'obsidian':
        // 还给宿主：不 preventDefault，让事件冒泡到 Obsidian 的快捷键系统
        // （如 Ctrl+Tab 切标签、Ctrl+1~5 等用户自定义键）。xterm 自身不处理。
        return false;
      case 'termy':
        if (event.type === 'keydown') {
          event.preventDefault();
          event.stopPropagation();
          this.runTermyKeyAction(match);
        }
        return false;
      default:
        return false;
    }
  }

  private runTermyKeyAction(match: KeybindingMatch): void {
    switch (match.action) {
      case 'tab-new': this.tabNavCallback?.({ type: 'new' }); break;
      case 'tab-close': this.tabNavCallback?.({ type: 'close' }); break;
      case 'tab-rename': this.tabNavCallback?.({ type: 'rename' }); break;
      case 'tab-next': this.tabNavCallback?.({ type: 'next' }); break;
      case 'tab-prev': this.tabNavCallback?.({ type: 'prev' }); break;
      case 'tab-goto':
        if (match.tabIndex !== undefined) {
          this.tabNavCallback?.({ type: 'goto', index: match.tabIndex });
        }
        break;
      case 'search-toggle': this.toggleSearch(); break;
      case 'font-increase': this.increaseFontSize(); break;
      case 'font-decrease': this.decreaseFontSize(); break;
      case 'font-reset': this.resetFontSize(); break;
      case 'copy': this.copySelectionToClipboard(); break;
      case 'paste': void this.pasteFromClipboard(); break;
      case 'newline':
        // 与 bracketed paste 一致地注入换行，让 Codex/Claude 当多行编辑而非提交。
        this.flushPendingInput();
        this.pasteText('\n');
        break;
    }
  }

  private copySelectionToClipboard(): void {
    const selection = this.xterm.getSelection();
    if (!selection) return;
    void this.writeToClipboard(selection, () => this.xterm.clearSelection());
  }

  /** 热更新键盘路由规则（设置变更时由 TerminalService 推送给每个活动终端）。 */
  setKeybindingRules(rules: KeybindingRule[]): void {
    this.keybindingRules = rules.length > 0 ? rules : DEFAULT_KEYBINDING_RULES;
  }

  setDefaultShellMenuCallbacks(
    getOptions: () => DefaultShellOption[],
    onChange: (shellType: DefaultShellOption['shellType']) => void,
  ): void {
    this.contextMenuCallbacks.getDefaultShellOptions = getOptions;
    this.contextMenuCallbacks.onDefaultShellChange = onChange;
  }

  // ==================== Other Public Methods ====================

  /**
   * Write data to the terminal
   */
  write(data: string): void {
    if (this.ptyClient && this.sessionId) {
      this.ptyClient.write(this.sessionId, data);
    }
  }

  sendText(data: string): void {
    this.write(data);
  }

  pasteText(text: string): void {
    const formatted = formatPastedTerminalText(text, this.xterm.modes.bracketedPasteMode);
    this.write(formatted);
  }

  async pasteFromClipboard(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        this.pasteText(text);
      }
    } catch (error) {
      errorLog('[Terminal] Paste failed:', error);
    }
  }

  detach(): void {
    this.disposeDomEventHandlers();
    this.xterm.element?.remove();
    this.containerEl = null;
    this.hostWindow = null;
  }

  focus(): void {
    if (!this.isDestroyed) this.xterm.focus();
  }

  isAlive(): boolean {
    return !this.isDestroyed && this.ptyClient !== null && this.ptyClient.isConnected();
  }

  getTitle(): string { return this.titleState.getTitle(); }

  isClaudeCodeSession(): boolean {
    return this.claudeCodeSessionState.isActive();
  }

  resetClaudeCodeSession(): void {
    this.claudeCodeSessionState.reset();
  }

  getOptions(): Readonly<TerminalOptions> {
    return this.options;
  }

  setTitle(title: string): void {
    this.applyTitleChange(this.titleState.setCustomTitle(title));
  }


  /**
   * Extract the current working directory from shell output.
   *
   * Recognizes (in priority order): OSC 7 (standard), OSC 9;9
   * (Windows Terminal / PowerShell), the Git Bash window-title OSC 0,
   * and finally the prompt-string parsers in `promptCwdParsers.ts`
   * for cmd / PowerShell / Git Bash / WSL.
   */
  private extractCwdFromOutput(data: string): void {
    // OSC 7 format (standard): \x1b]7;file://hostname/path\x07 or \x1b]7;file://hostname/path\x1b\\
    // eslint-disable-next-line no-control-regex -- Need to match ANSI control sequences
    const osc7Match = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)[\x07\x1b]/);
    if (osc7Match) {
      try {
        const path = decodeURIComponent(osc7Match[1]);
        this.currentCwd = path;
        debugLog('[Terminal CWD] OSC7 matched:', path);
        return;
      } catch {
        // Ignore decode failures
      }
    }

    // OSC 9;9 format (Windows Terminal/PowerShell): \x1b]9;9;path\x07
    // eslint-disable-next-line no-control-regex -- Need to match ANSI control sequences
    const osc9Match = data.match(/\x1b\]9;9;([^\x07\x1b]+)[\x07\x1b]/);
    if (osc9Match) {
      this.currentCwd = osc9Match[1];
      debugLog('[Terminal CWD] OSC9 matched:', this.currentCwd);
      return;
    }

    // OSC 0 (Git Bash window title): \x1b]0;MINGW64:/path\x07
    const gitBashWindowTitleCwd = extractGitBashWindowTitleCwd(data);
    if (gitBashWindowTitleCwd) {
      this.currentCwd = gitBashWindowTitleCwd;
      debugLog('[Terminal CWD] OSC0 (Git Bash) matched:', gitBashWindowTitleCwd);
      return;
    }

    // Prompt parsing (fallback for shells that do not emit OSC sequences).
    // eslint-disable-next-line no-control-regex -- Need to strip CSI sequences before prompt matching
    const cleanData = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    const psCwd = extractPowerShellCwd(cleanData);
    if (psCwd) {
      this.currentCwd = psCwd;
      debugLog('[Terminal CWD] PowerShell prompt matched:', psCwd);
      return;
    }

    const cmdCwd = extractCmdCwd(cleanData);
    if (cmdCwd) {
      this.currentCwd = cmdCwd;
      debugLog('[Terminal CWD] CMD prompt matched:', cmdCwd);
      return;
    }

    const gitBashCwd = extractGitBashPromptCwd(cleanData, getHomeDir());
    if (gitBashCwd) {
      this.currentCwd = gitBashCwd;
      debugLog('[Terminal CWD] Git Bash prompt matched:', gitBashCwd);
      return;
    }

    const wslCwd = extractWslPromptCwd(cleanData);
    if (wslCwd) {
      this.currentCwd = wslCwd;
      debugLog('[Terminal CWD] WSL prompt matched:', wslCwd);
    }
  }

  /**
   * Get the terminal's initial working directory
   */
  getInitialCwd(): string {
    return this.options.cwd || getHomeDir() || process.cwd();
  }

  /**
   * Get the current working directory.
   *
   * Strategy:
   *  1. Pull the prompt straight off the xterm screen at the cursor
   *     row. This is the reliable path for cmd under conpty (conpty
   *     sends cursor-positioning escapes instead of full prompt
   *     strings, but the rendered cells always show what the user
   *     sees) and is also a no-op upgrade for shells that already
   *     populate `currentCwd` via OSC 7/9;9 — the screen value
   *     matches what they wrote anyway.
   *  2. Trust `currentCwd` as the second-best source. It carries
   *     OSC-derived values that may be slightly fresher than the
   *     screen if the user is mid-typing a new command.
   *  3. Fall back to the initial cwd as a last resort.
   *
   * The screen value is intentionally NOT written back into
   * `currentCwd`: keeping screen-derived reads pure avoids polluting
   * the streaming-parser state in cases where the screen lags behind
   * an already-emitted OSC sequence.
   */
  getCwd(): string {
    const screenCwd = this.readCwdFromScreen();
    if (screenCwd) {
      if (screenCwd !== this.currentCwd) {
        debugLog('[Terminal CWD] Read from screen:', screenCwd);
      }
      return screenCwd;
    }
    return this.currentCwd || this.getInitialCwd();
  }

  /**
   * Read the cwd from the xterm.js buffer at the current cursor row.
   * Falls back to the previous line when the prompt may span two
   * rows (e.g. Git Bash's `\nuser@host MINGW64 /c/path\n$`).
   */
  private readCwdFromScreen(): string | null {
    try {
      const buffer = this.xterm.buffer.active;
      const cursorAbsoluteRow = buffer.baseY + buffer.cursorY;

      const cursorLine = buffer.getLine(cursorAbsoluteRow)?.translateToString(true) ?? '';
      const previousLine =
        cursorAbsoluteRow > 0
          ? (buffer.getLine(cursorAbsoluteRow - 1)?.translateToString(true) ?? null)
          : null;

      return extractCwdFromPromptLines(
        cursorLine,
        previousLine,
        getHomeDir()
      );
    } catch (error) {
      debugWarn('[Terminal CWD] readCwdFromScreen failed:', error);
      return null;
    }
  }

  navigatePrompt(direction: 'previous' | 'next'): boolean {
    const targetLine = this.findPromptLine(direction);
    if (targetLine === null) {
      return false;
    }

    this.xterm.scrollToLine(targetLine);
    this.focus();
    return true;
  }

  navigateToLastFailedCommand(): boolean {
    const marker = [...this.commandMarkers]
      .reverse()
      .find((entry) => !entry.marker.isDisposed && entry.marker.line >= 0 && (entry.exitCode ?? 0) !== 0);

    if (!marker) {
      return false;
    }

    this.xterm.scrollToLine(marker.marker.line);
    this.focus();
    return true;
  }

  private findPromptLine(direction: 'previous' | 'next'): number | null {
    const currentViewportLine = this.xterm.buffer.active.viewportY;
    const validPromptLines = this.promptMarkers
      .filter((marker) => !marker.isDisposed && marker.line >= 0)
      .map((marker) => marker.line)
      .sort((left, right) => left - right);

    if (direction === 'previous') {
      for (let index = validPromptLines.length - 1; index >= 0; index -= 1) {
        if (validPromptLines[index] < currentViewportLine) {
          return validPromptLines[index];
        }
      }

      return null;
    }

    for (const line of validPromptLines) {
      if (line > currentViewportLine) {
        return line;
      }
    }

    return null;
  }

  onTitleChange(callback: (title: string) => void): () => void {
    this.titleChangeCallbacks.add(callback);
    return () => {
      this.titleChangeCallbacks.delete(callback);
    };
  }

  /**
   * Listen for renderer changes (canvas <-> webgl).
   * The callback fires after the renderer addon has actually been swapped in,
   * so callers should treat the value as authoritative rather than guessing.
   */
  onRendererChange(callback: RendererChangeCallback): () => void {
    this.rendererChangeCallbacks.add(callback);
    return () => {
      this.rendererChangeCallbacks.delete(callback);
    };
  }

  getXterm(): Terminal { return this.xterm; }
  getFitAddon(): FitAddon { return this.fitAddon; }
  getSearchAddon(): SearchAddon { return this.searchAddon; }

  getCurrentRenderer(): 'canvas' | 'webgl' {
    return this.rendererType ?? this.options.preferredRenderer ?? 'canvas';
  }

  /**
   * Return the effective background color used by the active xterm theme.
   * Callers (e.g. the view layer) can paint surrounding container layers
   * with the same value to avoid the cell-aligned scrollable area exposing
   * a frame of a different color.
   */
  getEffectiveBackgroundColor(): string {
    return this.getTheme().background;
  }

  getEffectiveForegroundColor(): string {
    return this.getTheme().foreground;
  }

  /**
   * Convert mouse pixel coordinates to terminal row/column coordinates
   */
  private getTerminalCoordinates(x: number, y: number): { col: number; row: number } {
    const fontSize = this.xterm.options.fontSize || 14;
    const lineHeight = Math.ceil(fontSize * 1.2); // xterm.js default line height is about 1.2x the font size
    
    // Estimate character width for a monospace font at about 0.6x the font size
    const charWidth = fontSize * 0.6;
    
    const col = Math.floor(x / charWidth);
    const row = Math.floor(y / lineHeight);
    
    debugLog('[Terminal] Mouse coordinates:', { x, y, col, row, fontSize, charWidth, lineHeight });
    
    return { col, row };
  }

  /**
   * Convert a WSL path to a Windows path
   * @param wslPath A WSL-format path (for example, /mnt/c/Users/...)
   * @returns A Windows-format path (for example, C:\Users\...)
   */
  private convertWslPathToWindows(wslPath: string): string {
    // Match paths in /mnt/x/... format
    const wslMountMatch = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
    if (wslMountMatch) {
      const driveLetter = wslMountMatch[1].toUpperCase();
      const restPath = wslMountMatch[2].replace(/\//g, '\\');
      return `${driveLetter}:\\${restPath}`;
    }
    return wslPath;
  }

  /**
   * Open the specified path in the OS file manager.
   *
   * Termy invokes this only with directory paths (from `getCwd()`),
   * so Electron's `shell.openPath` is enough on every platform — it
   * defers to Explorer / Finder / xdg-open and removes the need to
   * spawn a child process or build a shell command string.
   *
   * @param targetPath The directory path to open
   */
  private openInFileManager(targetPath: string): void {
    const currentPlatform = getPlatform();

    debugLog('[Terminal] Opening in file manager, original path:', targetPath);

    let finalPath = targetPath;

    // If this is a WSL terminal, convert the WSL path to a Windows path
    if (currentPlatform === 'win32' && this.shellType === 'wsl' && targetPath.startsWith('/mnt/')) {
      finalPath = this.convertWslPathToWindows(targetPath);
      debugLog('[Terminal] Converted WSL path to Windows path:', { original: targetPath, converted: finalPath });
    }

    debugLog('[Terminal] Final path for file manager:', finalPath);

    void shell.openPath(finalPath).then((errorMessage) => {
      // Electron returns a non-empty string on failure, otherwise empty.
      if (errorMessage) {
        errorLog('[Terminal] Failed to open path via shell:', errorMessage);
      }
    }).catch((openError: unknown) => {
      errorLog('[Terminal] Failed to open path via shell:', openError);
    });
  }

  /**
   * Select the full contents of the specified line
   * @param row The line number
   */
  private selectLine(row: number): void {
    const buffer = this.xterm.buffer.active;
    
    // Ensure the line number is valid
    if (row < 0 || row >= buffer.length) {
      debugLog('[Terminal] Invalid row:', row);
      return;
    }
    
    this.xterm.selectLines(row, row);
    debugLog('[Terminal] Selected line:', row);
  }

  /**
   * Clear the screen
   * Clear the current screen contents while preserving scrollback history
   */
  private clearScreen(): void {
    // First send Ctrl+C to interrupt the current input
    if (this.ptyClient && this.sessionId) {
      this.ptyClient.write(this.sessionId, '\x03');
    }
    
    // Wait briefly for the interrupt to take effect, then send the clear command
    window.setTimeout(() => {
      if (this.isDestroyed) return;
      const clearCommand = isWindows() ? 'cls\r' : 'clear\r';
      if (this.ptyClient && this.sessionId) {
        this.ptyClient.write(this.sessionId, clearCommand);
      }
      debugLog('[Terminal] Screen cleared');
    }, 50);
  }

  /**
   * Clear the buffer
   * Fully reset terminal state, clearing all content and history
   */
  clearBuffer(): void {
    // First send Ctrl+C to interrupt the current input
    if (this.ptyClient && this.sessionId) {
      this.ptyClient.write(this.sessionId, '\x03');
    }
    
    // Wait briefly for the interrupt to take effect
    window.setTimeout(() => {
      // 销毁后 xterm 已 dispose，访问会抛异常，直接跳过。
      if (this.isDestroyed) return;
      // Send the clear command to the shell
      const clearCommand = isWindows() ? 'cls\r' : 'clear\r';
      if (this.ptyClient && this.sessionId) {
        this.ptyClient.write(this.sessionId, clearCommand);
      }

      // Clear xterm.js scrollback and state
      this.kittyGraphicsProtocol.reset();
      this.kittyGraphicsRenderer?.clear();
      this.xterm.clear();
      this.xterm.reset();
      this.xterm.clearSelection();

      debugLog('[Terminal] Buffer cleared and terminal reset');
    }, 50);
  }

  updateTheme(): void {
    const theme = this.getTheme();
    this.xterm.options.theme = theme;
    this.xterm.options.allowTransparency = this.shouldUseTransparentTerminalBackground();
    this.syncBackgroundLayerStyles(theme.background);
    this.xterm.refresh(0, this.xterm.rows - 1);
  }

  updateOptions(options: Partial<TerminalOptions>): void {
    const previousScrollback = this.options.scrollback;
    const previousRenderer = this.options.preferredRenderer || 'canvas';
    const previousTransparentBackground = this.shouldUseTransparentTerminalBackground();
    this.options = { ...this.options, ...options };
    if (!this.isInitialized) {
      return;
    }
    const nextTransparentBackground = this.shouldUseTransparentTerminalBackground();
    if (options.scrollback !== undefined && options.scrollback !== previousScrollback) {
      this.xterm.options.scrollback = options.scrollback;
    }
    if (options.fontSize !== undefined) {
      this.setFontSize(options.fontSize);
    }
    if (options.fontFamily !== undefined) {
      this.xterm.options.fontFamily = options.fontFamily;
      this.fit();
    }
    if (options.cursorStyle !== undefined) {
      this.xterm.options.cursorStyle = options.cursorStyle;
    }
    if (options.cursorBlink !== undefined) {
      this.xterm.options.cursorBlink = options.cursorBlink;
    }
    this.updateTheme();
    const nextRenderer = this.options.preferredRenderer || 'canvas';
    if (nextTransparentBackground !== previousTransparentBackground) {
      this.reopenTerminalElement();
    } else if (nextRenderer !== previousRenderer) {
      this.refreshRenderer();
    }
  }
}
