export const THEME_IDS = [
  "tokyo-night",
  "gruvbox-dark",
  "solarized-dark",
  "dracula",
  "everforest",
  "catppuccin-latte",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const THEME_TOKENS = [
  "background",
  "foreground",
  "muted-text",
  "border",
  "accent",
  "active-tab",
  "inactive-tab",
  "statusline",
  "error",
  "search-highlight",
  "active-search-highlight",
  "focus-indicator",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export type ThemePalette = Readonly<Record<ThemeToken, string>>;

export interface Theme {
  readonly id: ThemeId;
  readonly displayName: string;
  readonly palette: ThemePalette;
}

export const DEFAULT_THEME_ID: ThemeId = "tokyo-night";

function palette(values: Record<ThemeToken, string>): ThemePalette {
  return Object.freeze(values);
}

function theme(id: ThemeId, displayName: string, values: Record<ThemeToken, string>): Theme {
  return Object.freeze({ id, displayName, palette: palette(values) });
}

/**
 * Frozen built-in chrome palettes from Modeleaf Theme.swift/BuiltInThemes.swift
 * at d809e2e4d6aa5f257c91ff38b2cd4503e17405f0.
 */
export const THEMES: readonly Theme[] = Object.freeze([
  theme("tokyo-night", "Tokyo Night", {
    "background": "#1A1B26", "foreground": "#C0CAF5", "muted-text": "#9AA5CE", "border": "#3B4261",
    "accent": "#7AA2F7", "active-tab": "#24283B", "inactive-tab": "#16161E", "statusline": "#101014",
    "error": "#F7768E", "search-highlight": "#E0AF68", "active-search-highlight": "#FF9E64", "focus-indicator": "#7AA2F7",
  }),
  theme("gruvbox-dark", "Gruvbox Dark", {
    "background": "#282828", "foreground": "#EBDBB2", "muted-text": "#A89984", "border": "#504945",
    "accent": "#83A598", "active-tab": "#3C3836", "inactive-tab": "#1D2021", "statusline": "#1D2021",
    "error": "#FB4934", "search-highlight": "#FABD2F", "active-search-highlight": "#FE8019", "focus-indicator": "#83A598",
  }),
  theme("solarized-dark", "Solarized Dark", {
    "background": "#002B36", "foreground": "#839496", "muted-text": "#586E75", "border": "#0B4F5E",
    "accent": "#268BD2", "active-tab": "#073642", "inactive-tab": "#001F27", "statusline": "#001F27",
    "error": "#DC322F", "search-highlight": "#B58900", "active-search-highlight": "#CB4B16", "focus-indicator": "#268BD2",
  }),
  theme("dracula", "Dracula", {
    "background": "#282A36", "foreground": "#F8F8F2", "muted-text": "#6272A4", "border": "#44475A",
    "accent": "#BD93F9", "active-tab": "#44475A", "inactive-tab": "#21222C", "statusline": "#191A21",
    "error": "#FF5555", "search-highlight": "#F1FA8C", "active-search-highlight": "#FFB86C", "focus-indicator": "#BD93F9",
  }),
  theme("everforest", "Everforest", {
    "background": "#2D353B", "foreground": "#D3C6AA", "muted-text": "#859289", "border": "#475258",
    "accent": "#A7C080", "active-tab": "#343F44", "inactive-tab": "#232A2E", "statusline": "#232A2E",
    "error": "#E67E80", "search-highlight": "#DBBC7F", "active-search-highlight": "#E69875", "focus-indicator": "#A7C080",
  }),
  theme("catppuccin-latte", "Catppuccin Latte", {
    "background": "#EFF1F5", "foreground": "#4C4F69", "muted-text": "#6C6F85", "border": "#BCC0CC",
    "accent": "#1E66F5", "active-tab": "#DCE0E8", "inactive-tab": "#E6E9EF", "statusline": "#DCE0E8",
    "error": "#D20F39", "search-highlight": "#DF8E1D", "active-search-highlight": "#FE640B", "focus-indicator": "#1E66F5",
  }),
]);

export function isThemeId(value: string): value is ThemeId {
  return (THEME_IDS as readonly string[]).includes(value);
}

export function themeForId(id: ThemeId): Theme {
  const selected = THEMES.find((candidate) => candidate.id === id);
  if (selected === undefined) throw new Error(`Missing built-in theme: ${id}`);
  return selected;
}
export interface DurableThemeState {
  readonly themeId: ThemeId;
  readonly revision: number;
}

export function adoptDurableThemeState(current: DurableThemeState, candidate: DurableThemeState): DurableThemeState {
  if (candidate.revision > current.revision) return candidate;
  if (candidate.revision === current.revision && candidate.themeId === current.themeId) return current;
  return current;
}
