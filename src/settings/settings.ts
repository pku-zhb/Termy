/**
 * Terminal settings type definitions
 * Includes all terminal-related configuration options
 */

import type { VisibilityConfig } from '@/services/visibility';
import { DEFAULT_KEYBINDING_CONFIG_JSON } from '@/services/terminal/keybindingRules';

/** Terminal programs that can be launched from the shell selector when installed */
export type TerminalShellType = 'tmux';

/** Shell types supported on Windows */
export type WindowsShellType = 'cmd' | 'powershell' | 'pwsh' | 'wsl' | 'gitbash' | TerminalShellType | 'custom';

/** Shell types supported on Unix platforms (macOS/Linux) */
export type UnixShellType = 'bash' | 'zsh' | TerminalShellType | 'custom';

/** Union of all shell types */
export type ShellType = WindowsShellType | UnixShellType;

/**
 * Platform-specific shell configuration
 */
export interface PlatformShellConfig {
  windows: WindowsShellType;
  darwin: UnixShellType;  // macOS
  linux: UnixShellType;
}

/**
 * Platform-specific custom shell paths
 */
export interface PlatformCustomShellPaths {
  windows: string;
  darwin: string;
  linux: string;
}

/**
 * Terminal settings interface
 */
export interface TerminalSettings {
  // Default shell program type for each platform (stored separately)
  platformShells: PlatformShellConfig;

  // Custom shell path for each platform (stored separately)
  platformCustomShellPaths: PlatformCustomShellPaths;

  // Default launch arguments
  shellArgs: string[];

  // Startup directory settings
  autoEnterVaultDirectory: boolean; // Automatically enter the project directory when opening a terminal

  // Terminal appearance settings
  fontSize: number;
  fontFamily: string;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;

  // Theme settings
  useObsidianTheme: boolean;      // Whether to use Obsidian theme colors
  backgroundColor?: string;        // Custom background color
  foregroundColor?: string;        // Custom foreground color

  // Background image settings
  backgroundImage?: string;        // Background image URL
  backgroundImageOpacity?: number; // Background image opacity (0-1.0)
  backgroundImageSize?: 'cover' | 'contain' | 'auto'; // Background image size
  backgroundImagePosition?: string; // Background image position
  
  // Frosted glass effect
  enableBlur?: boolean;            // Whether to enable the frosted glass effect
  blurAmount?: number;             // Frosted glass blur amount (0-20px)

  // Text opacity
  textOpacity?: number;            // Text opacity (0-1.0)

  // Renderer type: Canvas (recommended), WebGL (high performance)
  // Note: The DOM renderer is deprecated and is no longer provided due to issues such as cursor positioning
  preferredRenderer: 'canvas' | 'webgl';

  // Scrollback buffer size (in lines)
  scrollback: number;


  // Feature visibility settings
  visibility: VisibilityConfig;

  // Preset scripts
  presetScripts: PresetScript[];

  // When true, hide AI launchers whose underlying CLI was not found on PATH.
  // Default false so a fresh install still shows install guidance for every
  // built-in launcher; experienced users can flip this to declutter their menu.

  // When true, Termy queries the npm registry / GitHub Releases API to find
  // out whether a newer version of each AI launcher CLI is available.
  // Default false because it introduces outbound traffic that the README
  // and AGENTS.md disclose only when the user opts in.

  // Latest version whose changelog modal has already been shown
  lastSeenChangelogVersion: string;

  // 键盘路由配置（when→route 的 JSON 文本，用户可在设置里编辑）。
  keybindings: string;

  // Debug settings
  enableDebugLog: boolean;
}

/**
 * Workflow action type
 */
export type PresetWorkflowActionType = 'terminal-command' | 'obsidian-command' | 'open-external';

/**
 * Workflow action definition
 */
export interface PresetWorkflowAction {
  id: string;
  type: PresetWorkflowActionType;
  value: string;
  enabled: boolean;
  note: string;
}

/**
 * Preset workflow definition
 */
export interface PresetScript {
  id: string;
  /** Source ID of the workflow marketplace template (present only for marketplace imports) */
  sourceTemplateId?: string;
  name: string;
  icon: string;
  actions: PresetWorkflowAction[];
  terminalTitle: string;
  showInStatusBar: boolean;
  autoOpenTerminal: boolean;
  runInNewTerminal: boolean;
}

/**
 * Default preset scripts
 */
export const CODEX_LAUNCH_COMMAND =
  'codex';

export const OPENCODE_LAUNCH_COMMAND =
  'opencode';

const CONTEXT_AWARE_PRESET_SCRIPT_IDS = new Set(['claude-code', 'codex', 'opencode']);

export function isContextAwarePresetScript(script: Pick<PresetScript, 'id'>): boolean {
  return CONTEXT_AWARE_PRESET_SCRIPT_IDS.has(script.id);
}

// 魔改 fork：默认不预置任何 AI 启动器脚本（claude/codex/opencode）
export const DEFAULT_PRESET_SCRIPTS: PresetScript[] = [];

/**
 * Default platform shell configuration
 */
export const DEFAULT_PLATFORM_SHELLS: PlatformShellConfig = {
  windows: 'cmd',
  darwin: 'zsh',
  linux: 'bash'
};

/**
 * Default platform custom shell paths
 */
export const DEFAULT_PLATFORM_CUSTOM_SHELL_PATHS: PlatformCustomShellPaths = {
  windows: '',
  darwin: '',
  linux: ''
};

/**
 * Get the shell type for the current platform
 */
export function getCurrentPlatformShell(settings: TerminalSettings): ShellType {
  const platform = process.platform;
  if (platform === 'win32') {
    return settings.platformShells.windows;
  } else if (platform === 'darwin') {
    return settings.platformShells.darwin;
  } else {
    return settings.platformShells.linux;
  }
}

/**
 * Set the shell type for the current platform
 */
export function setCurrentPlatformShell(settings: TerminalSettings, shellType: ShellType): void {
  const platform = process.platform;
  if (platform === 'win32') {
    settings.platformShells.windows = shellType as WindowsShellType;
  } else if (platform === 'darwin') {
    settings.platformShells.darwin = shellType as UnixShellType;
  } else {
    settings.platformShells.linux = shellType as UnixShellType;
  }
}

/**
 * Get the custom shell path for the current platform
 */
export function getCurrentPlatformCustomShellPath(settings: TerminalSettings): string {
  const platform = process.platform;
  if (platform === 'win32') {
    return settings.platformCustomShellPaths.windows;
  } else if (platform === 'darwin') {
    return settings.platformCustomShellPaths.darwin;
  } else {
    return settings.platformCustomShellPaths.linux;
  }
}

/**
 * Set the custom shell path for the current platform
 */
export function setCurrentPlatformCustomShellPath(
  settings: TerminalSettings,
  path: string
): void {
  const platform = process.platform;
  if (platform === 'win32') {
    settings.platformCustomShellPaths.windows = path;
  } else if (platform === 'darwin') {
    settings.platformCustomShellPaths.darwin = path;
  } else {
    settings.platformCustomShellPaths.linux = path;
  }
}

/**
 * Default terminal settings
 */
export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  platformShells: { ...DEFAULT_PLATFORM_SHELLS },
  platformCustomShellPaths: { ...DEFAULT_PLATFORM_CUSTOM_SHELL_PATHS },
  shellArgs: [],
  autoEnterVaultDirectory: true,
  fontSize: 14,
  fontFamily: 'Consolas, "Courier New", monospace',
  cursorStyle: 'block',
  cursorBlink: true,
  useObsidianTheme: true,
  preferredRenderer: 'canvas',
  scrollback: 1000,
  backgroundImageOpacity: 0.5,
  backgroundImageSize: 'cover',
  backgroundImagePosition: 'center',
  enableBlur: false,
  blurAmount: 10,
  textOpacity: 1.0,
  visibility: {
    enabled: true,
    showInCommandPalette: true,
    showInRibbon: true,
    showInNewTab: true,
    showInStatusBar: false,
  },
  presetScripts: [...DEFAULT_PRESET_SCRIPTS],
  lastSeenChangelogVersion: '',
  keybindings: DEFAULT_KEYBINDING_CONFIG_JSON,
  enableDebugLog: false,
};
