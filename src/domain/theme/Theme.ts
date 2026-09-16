export const THEME_IDS = [
  "tokyo-night",
  "gruvbox-dark",
  "solarized-dark",
  "dracula",
  "everforest",
  "nord",
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

const palette = (values: Record<ThemeToken, string>): ThemePalette => Object.freeze(values);
const theme = (id: ThemeId, displayName: string, values: Record<ThemeToken, string>): Theme =>
  Object.freeze({ id, displayName, palette: palette(values) });

export const THEMES: readonly Theme[] = Object.freeze([
  theme("tokyo-night", "Tokyo Night", { "background":"#1A1B26","foreground":"#C0CAF5","muted-text":"#9AA5CE","border":"#3B4261","accent":"#7AA2F7","active-tab":"#24283B","inactive-tab":"#16161E","statusline":"#101014","error":"#F7768E","search-highlight":"#E0AF68","active-search-highlight":"#FF9E64","focus-indicator":"#7AA2F7" }),
  theme("gruvbox-dark", "Gruvbox Dark", { "background":"#282828","foreground":"#EBDBB2","muted-text":"#A89984","border":"#504945","accent":"#83A598","active-tab":"#3C3836","inactive-tab":"#1D2021","statusline":"#1D2021","error":"#FB4934","search-highlight":"#FABD2F","active-search-highlight":"#FE8019","focus-indicator":"#83A598" }),
  theme("solarized-dark", "Solarized Dark", { "background":"#002B36","foreground":"#839496","muted-text":"#586E75","border":"#0B4F5E","accent":"#268BD2","active-tab":"#073642","inactive-tab":"#001F27","statusline":"#001F27","error":"#DC322F","search-highlight":"#B58900","active-search-highlight":"#CB4B16","focus-indicator":"#268BD2" }),
  theme("dracula", "Dracula", { "background":"#282A36","foreground":"#F8F8F2","muted-text":"#6272A4","border":"#44475A","accent":"#BD93F9","active-tab":"#44475A","inactive-tab":"#21222C","statusline":"#191A21","error":"#FF5555","search-highlight":"#F1FA8C","active-search-highlight":"#FFB86C","focus-indicator":"#BD93F9" }),
  theme("everforest", "Everforest", { "background":"#2D353B","foreground":"#D3C6AA","muted-text":"#859289","border":"#475258","accent":"#A7C080","active-tab":"#343F44","inactive-tab":"#232A2E","statusline":"#232A2E","error":"#E67E80","search-highlight":"#DBBC7F","active-search-highlight":"#E69875","focus-indicator":"#A7C080" }),
  theme("nord", "Nord", { "background":"#2E3440","foreground":"#D8DEE9","muted-text":"#81A1C1","border":"#4C566A","accent":"#88C0D0","active-tab":"#3B4252","inactive-tab":"#272C36","statusline":"#242933","error":"#BF616A","search-highlight":"#EBCB8B","active-search-highlight":"#D08770","focus-indicator":"#88C0D0" }),
  theme("catppuccin-latte", "Catppuccin Latte", { "background":"#EFF1F5","foreground":"#4C4F69","muted-text":"#6C6F85","border":"#BCC0CC","accent":"#1E66F5","active-tab":"#DCE0E8","inactive-tab":"#E6E9EF","statusline":"#DCE0E8","error":"#D20F39","search-highlight":"#DF8E1D","active-search-highlight":"#FE640B","focus-indicator":"#1E66F5" }),
]);

const THEME_BY_ID = Object.freeze(Object.fromEntries(THEMES.map((candidate) => [candidate.id, candidate])) as Record<ThemeId, Theme>);
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && Object.hasOwn(THEME_BY_ID, value);
}
export function themeForId(id: ThemeId): Theme { return THEME_BY_ID[id]; }

export interface DurableThemeState { readonly themeId: ThemeId; readonly revision: number }

/** The renderer default is replaceable until native returns its startup snapshot. */
export function shouldAdoptDurableThemeState(
  current: DurableThemeState,
  candidate: DurableThemeState,
  isProvisional: boolean,
): boolean {
  return isProvisional
    || candidate.revision > current.revision
    || (candidate.revision === current.revision && candidate.themeId === current.themeId);
}

export function adoptDurableThemeState(current: DurableThemeState, candidate: DurableThemeState): DurableThemeState {
  return candidate.revision > current.revision ? candidate : current;
}

/** Contrast endpoint for derived translucent surfaces; independent of theme identity. */
export function themeContrastEndpoint(palette: ThemePalette): "#000000" | "#ffffff" {
  const channels = palette.background.slice(1).match(/../g)!.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
