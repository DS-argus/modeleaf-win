import type { Action, ActionType } from "./Action";
import { token, tokenSignature, type KeyToken } from "./KeyToken";

export type BindingCommand = ActionType | "page.target" | "prompt.backspace";
export type BindingContext = "global" | "reader" | "pagePrompt";
export type BindingKind = "exact" | "prefix" | "sequence" | "digit";
export interface CommandAvailabilityContext {
  readonly hasDocument: boolean;
  readonly canCreateSession: boolean;
  readonly canOpenDocument: boolean;
  readonly tabCount?: number;
  readonly modalOpen: boolean;
  readonly pagePromptActive?: boolean;
}

export interface CommandAvailability {
  readonly requiresSessionCapacity: boolean;
  readonly requiresOpenDocument: boolean;
  readonly allowWhenModalOpen: boolean;
}

const DEFAULT_COMMAND_AVAILABILITY: CommandAvailability = {
  requiresSessionCapacity: false,
  requiresOpenDocument: false,
  allowWhenModalOpen: true,
};

const OPEN_DOCUMENT_AVAILABILITY: CommandAvailability = {
  requiresSessionCapacity: false,
  requiresOpenDocument: true,
  allowWhenModalOpen: false,
};

const NEW_WINDOW_AVAILABILITY: CommandAvailability = {
  requiresSessionCapacity: false,
  requiresOpenDocument: false,
  allowWhenModalOpen: false,
};

export const DEFAULT_COMMAND_AVAILABILITY_CONTEXT: CommandAvailabilityContext = {
  tabCount: 8,
  hasDocument: true,
  canCreateSession: true,
  pagePromptActive: false,
  canOpenDocument: true,
  modalOpen: false,
};

export function formatShortcutKeys(keys: readonly string[]): string {
  return keys.map((key) => /^[A-Z]$/.test(key) ? `Shift+${key}` : key).join(" ");
}

export function isCommandEnabled(binding: BindingDescriptor, context: CommandAvailabilityContext = DEFAULT_COMMAND_AVAILABILITY_CONTEXT): boolean {
  const tabIndex = binding.action?.type === "tab.activate" ? binding.action.index : undefined;
  const tabCount = context.tabCount ?? DEFAULT_COMMAND_AVAILABILITY_CONTEXT.tabCount!;
  return (binding.contexts.includes("global") || context.hasDocument)
    && (!binding.contexts.includes("pagePrompt") || binding.contexts.includes("global") || context.pagePromptActive === true)
    && (binding.availability.allowWhenModalOpen || !context.modalOpen)
    && (!binding.availability.requiresOpenDocument || context.canOpenDocument)
    && (!binding.availability.requiresSessionCapacity || context.canCreateSession)
    && (tabIndex === undefined || (tabIndex === -1 ? tabCount > 0 : tabIndex < tabCount));
}

export interface BindingDescriptor {
  readonly id: string;
  readonly keys: readonly string[];
  readonly label: string;
  readonly command: BindingCommand;
  readonly action?: Action;
  readonly paletteAction?: "page.target";
  readonly repeatable: boolean;
  readonly contexts: readonly BindingContext[];
  readonly kind: BindingKind;
  readonly directToken?: KeyToken;
  readonly showInHelp: boolean;
  readonly showInPalette: boolean;
  readonly availability: CommandAvailability;
}

export const DEFAULT_BINDINGS: readonly BindingDescriptor[] = [
  {
    id: "document.open",
    keys: ["Ctrl+O"],
    label: "Open PDF",
    command: "document.open",
    action: { type: "document.open" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("o", { ctrl: true }),
    showInHelp: true,
    showInPalette: true,
    availability: OPEN_DOCUMENT_AVAILABILITY,
  },
  {
    id: "document.print",
    keys: ["Ctrl+P"],
    label: "Print",
    command: "document.print",
    action: { type: "document.print" },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("p", { ctrl: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "app.new",
    keys: ["Ctrl+N"],
    label: "New window",
    command: "application.new",
    action: { type: "application.new" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("n", { ctrl: true }),
    showInHelp: true,
    showInPalette: true,
    availability: NEW_WINDOW_AVAILABILITY,
  },
  {
    id: "tab.close",
    keys: ["Ctrl+W"],
    label: "Close tab",
    command: "tab.close",
    action: { type: "tab.close" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("w", { ctrl: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  ...Array.from({ length: 8 }, (_, index): BindingDescriptor => ({
    id: `tab.activate.${index + 1}`,
    keys: [`Ctrl+${index + 1}`],
    label: `Activate tab ${index + 1}`,
    command: "tab.activate",
    action: { type: "tab.activate", index },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token(String(index + 1), { ctrl: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  })),
  {
    id: "tab.activate.last",
    keys: ["Ctrl+9"],
    label: "Activate last tab",
    command: "tab.activate",
    action: { type: "tab.activate", index: -1 },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("9", { ctrl: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "tab.next",
    keys: ["N"],
    label: "Next tab",
    command: "tab.next",
    action: { type: "tab.next" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("N", { shift: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "tab.previous",
    keys: ["P"],
    label: "Previous tab",
    command: "tab.previous",
    action: { type: "tab.previous" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("P", { shift: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "palette.toggle",
    keys: ["Ctrl+Shift+P"],
    label: "Command palette",
    command: "palette.toggle",
    action: { type: "palette.toggle" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("p", { ctrl: true, shift: true }),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "palette.toggle.colon",
    keys: [":"],
    label: "Command palette",
    command: "palette.toggle",
    action: { type: "palette.toggle" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token(":", { shift: true }),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "theme.open",
    keys: ["T"],
    label: "Choose theme",
    command: "theme.open",
    action: { type: "theme.open" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("T", { shift: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "application.quit",
    keys: ["Ctrl+Q"],
    label: "Quit after owned cleanup",
    command: "application.quit",
    action: { type: "application.quit" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("q", { ctrl: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.next",
    keys: ["n"],
    label: "Next page",
    command: "page.next",
    action: { type: "page.next" },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("n"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.previous",
    keys: ["p"],
    label: "Previous page",
    command: "page.previous",
    action: { type: "page.previous" },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("p"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.previous.arrow",
    keys: ["ArrowLeft"],
    label: "Previous page",
    command: "page.previous",
    action: { type: "page.previous" },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("ArrowLeft"),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.next.arrow",
    keys: ["ArrowRight"],
    label: "Next page",
    command: "page.next",
    action: { type: "page.next" },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("ArrowRight"),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.up.arrow",
    keys: ["ArrowUp"],
    label: "Scroll up",
    command: "scroll.byCssPixels",
    action: { type: "scroll.byCssPixels", axis: "vertical", delta: -48 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("ArrowUp"),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.down.arrow",
    keys: ["ArrowDown"],
    label: "Scroll down",
    command: "scroll.byCssPixels",
    action: { type: "scroll.byCssPixels", axis: "vertical", delta: 48 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("ArrowDown"),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.target",
    keys: ["g", "digits", "Enter"],
    label: "Go to page",
    command: "page.target",
    paletteAction: "page.target",
    repeatable: false,
    contexts: ["reader"],
    kind: "prefix",
    directToken: token("g"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.target.digit",
    keys: ["0…9"],
    label: "Enter page number",
    command: "page.target",
    repeatable: true,
    contexts: ["pagePrompt"],
    kind: "digit",
    showInHelp: false,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.first",
    keys: ["g", "g"],
    label: "First page",
    command: "page.first",
    action: { type: "page.first" },
    repeatable: false,
    contexts: ["reader"],
    kind: "sequence",
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "page.last",
    keys: ["G"],
    label: "Last page",
    command: "page.last",
    action: { type: "page.last" },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("G", { shift: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.left",
    keys: ["h"],
    label: "Scroll left",
    command: "scroll.byCssPixels",
    action: { type: "scroll.byCssPixels", axis: "horizontal", delta: -48 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("h"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.down",
    keys: ["j"],
    label: "Scroll down",
    command: "scroll.byCssPixels",
    action: { type: "scroll.byCssPixels", axis: "vertical", delta: 48 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("j"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.up",
    keys: ["k"],
    label: "Scroll up",
    command: "scroll.byCssPixels",
    action: { type: "scroll.byCssPixels", axis: "vertical", delta: -48 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("k"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.right",
    keys: ["l"],
    label: "Scroll right",
    command: "scroll.byCssPixels",
    action: { type: "scroll.byCssPixels", axis: "horizontal", delta: 48 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("l"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.viewportDown",
    keys: ["d"],
    label: "Scroll down 0.8 viewport",
    command: "scroll.byViewport",
    action: { type: "scroll.byViewport", factor: 0.8 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("d"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "scroll.viewportUp",
    keys: ["u"],
    label: "Scroll up 0.8 viewport",
    command: "scroll.byViewport",
    action: { type: "scroll.byViewport", factor: -0.8 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("u"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "view.fitWidth",
    keys: ["w"],
    label: "Fit width",
    command: "view.fitWidth",
    action: { type: "view.fitWidth" },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("w"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "view.fitPage",
    keys: ["F"],
    label: "Fit page",
    command: "view.fitPage",
    action: { type: "view.fitPage" },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("F", { shift: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "view.zoomIn",
    keys: ["="],
    label: "Zoom in",
    command: "view.zoom",
    action: { type: "view.zoom", factor: 1.1 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("="),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "view.zoomOut",
    keys: ["-"],
    label: "Zoom out",
    command: "view.zoom",
    action: { type: "view.zoom", factor: 1 / 1.1 },
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("-"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "view.rotateCounterclockwise",
    keys: ["["],
    label: "Rotate counterclockwise",
    command: "view.rotate",
    action: { type: "view.rotate", quarterTurns: -1 },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("["),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "view.rotateClockwise",
    keys: ["]"],
    label: "Rotate clockwise",
    command: "view.rotate",
    action: { type: "view.rotate", quarterTurns: 1 },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("]"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "search.open",
    keys: ["/"],
    label: "Search text",
    command: "search.open",
    action: { type: "search.open" },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("/"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "linkHints.toggle",
    keys: ["f"],
    label: "Open link hint",
    command: "linkHints.toggle",
    action: { type: "linkHints.toggle" },
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("f"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "help.toggle",
    keys: ["?"],
    label: "Keyboard help",
    command: "help.toggle",
    action: { type: "help.toggle" },
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("?", { shift: true }),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "prompt.commit",
    keys: ["Enter"],
    label: "Go to entered page",
    command: "page.goTo",
    repeatable: false,
    contexts: ["pagePrompt"],
    kind: "exact",
    directToken: token("Enter"),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "prompt.cancel",
    keys: ["Esc"],
    label: "Cancel prompt or close overlay",
    command: "prompt.cancel",
    action: { type: "prompt.cancel" },
    repeatable: false,
    contexts: ["global", "pagePrompt"],
    kind: "exact",
    directToken: token("Escape"),
    showInHelp: true,
    showInPalette: true,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
  {
    id: "prompt.backspace",
    keys: ["Backspace"],
    label: "Delete page digit",
    command: "prompt.backspace",
    repeatable: true,
    contexts: ["pagePrompt"],
    kind: "exact",
    directToken: token("Backspace"),
    showInHelp: true,
    showInPalette: false,
    availability: DEFAULT_COMMAND_AVAILABILITY,
  },
] as const;

export type PaletteBindingAction =
  | { readonly kind: "dispatch"; readonly action: Action }
  | { readonly kind: "page.target" };

export function resolveBindingAction(binding: BindingDescriptor): Action | undefined {
  return binding.action;
}

export function resolvePaletteBindingAction(binding: BindingDescriptor): PaletteBindingAction | undefined {
  const action = resolveBindingAction(binding);
  if (action !== undefined) return { kind: "dispatch", action };
  return binding.paletteAction === "page.target" ? { kind: "page.target" } : undefined;
}

export function bindingById(id: string): BindingDescriptor {
  const binding = DEFAULT_BINDINGS.find((candidate) => candidate.id === id);
  if (!binding) {
    throw new Error(`Unknown binding: ${id}`);
  }
  return binding;
}

export function matchesDirectToken(binding: BindingDescriptor, value: KeyToken): boolean {
  const directToken = binding.directToken;
  return directToken !== undefined && tokenSignature(directToken) === tokenSignature(value);
}

export function bindingAcceptsContext(
  binding: BindingDescriptor,
  context: Exclude<BindingContext, "global">,
): boolean {
  return binding.contexts.includes("global") || binding.contexts.includes(context);
}

export function findExactBinding(
  value: KeyToken,
  context: Exclude<BindingContext, "global">,
): BindingDescriptor | undefined {
  return DEFAULT_BINDINGS.find((binding) =>
    binding.kind === "exact"
    && matchesDirectToken(binding, value)
    && bindingAcceptsContext(binding, context),
  );
}

export function isPageTargetDigit(value: KeyToken): boolean {
  const binding = bindingById("page.target.digit");
  return binding.kind === "digit"
    && !value.ctrl
    && !value.shift
    && !value.alt
    && !value.meta
    && /^[0-9]$/.test(value.key);
}

export function isRegisteredCtrlChord(value: KeyToken): boolean {
  if (!value.ctrl || value.alt || value.meta) {
    return false;
  }
  return DEFAULT_BINDINGS.some((binding) =>
    binding.directToken?.ctrl === true
    && matchesDirectToken(binding, value),
  );
}
