export const INPUT_CONTEXTS = Object.freeze([
  "navigation",
  "pagePrompt",
  "searchPrompt",
  "searchResults",
] as const);

export type InputContext = (typeof INPUT_CONTEXTS)[number];

export const ACTION_IDS = Object.freeze([
  "document.open", "document.close", "document.print", "app.quit", "app.new", "palette.open", "help.show",
  "tab.next", "tab.previous",
  "scroll.left", "scroll.down", "scroll.up", "scroll.right", "scroll.largeDown", "scroll.largeUp",
  "page.next", "page.previous", "page.first", "page.last", "page.prompt", "history.back", "history.forward",
  "prompt.commit", "prompt.cancel", "search.prompt", "search.next", "search.previous", "search.cancel",
  "view.zoomIn", "view.zoomOut", "view.zoomReset", "view.fitWidth", "view.fitPage", "view.rotateLeft", "view.rotateRight",
  "config.reload", "config.writeDefault", "config.resetDefault", "theme.picker", "update.show",
  "path.showParent", "path.copy",
] as const);

export type ActionId = (typeof ACTION_IDS)[number];
export type ActionRepeatBehavior = "allowed" | "suppressed";
export type ActionBindingConfiguration = "fixed" | "configurable";

export type ActionAvailabilityScope =
  | { readonly kind: "global" }
  | { readonly kind: "contexts"; readonly contexts: readonly InputContext[] };

export interface ActionDescriptor {
  readonly id: ActionId;
  readonly displayName: string;
  readonly availability: ActionAvailabilityScope;
  readonly repeatBehavior: ActionRepeatBehavior;
  readonly bindingConfiguration: ActionBindingConfiguration;
}

const GLOBAL: ActionAvailabilityScope = Object.freeze({ kind: "global" });
const READER_CONTEXTS = Object.freeze(["navigation", "searchResults"] as const);
const PROMPT_CONTEXTS = Object.freeze(["pagePrompt", "searchPrompt"] as const);
const NAVIGATION_CONTEXT = Object.freeze(["navigation"] as const);
const SEARCH_RESULTS_CONTEXT = Object.freeze(["searchResults"] as const);

function contexts(contextsForAvailability: readonly InputContext[]): ActionAvailabilityScope {
  return Object.freeze({ kind: "contexts", contexts: Object.freeze([...contextsForAvailability]) });
}

function descriptor(
  id: ActionId,
  displayName: string,
  availability: ActionAvailabilityScope,
  repeatBehavior: ActionRepeatBehavior = "suppressed",
  bindingConfiguration: ActionBindingConfiguration = "configurable",
): ActionDescriptor {
  return Object.freeze({ id, displayName, availability, repeatBehavior, bindingConfiguration });
}

export const ACTION_DESCRIPTORS: readonly ActionDescriptor[] = Object.freeze([
  descriptor("document.open", "Open PDF…", GLOBAL),
  descriptor("document.close", "Close PDF", contexts(READER_CONTEXTS)),
  descriptor("document.print", "Print…", GLOBAL),
  descriptor("app.quit", "Close Window", GLOBAL),
  descriptor("app.new", "New Window", GLOBAL),
  descriptor("palette.open", "Command Palette", contexts(READER_CONTEXTS)),
  descriptor("help.show", "Keyboard Help", contexts(NAVIGATION_CONTEXT)),

  descriptor("tab.next", "Next Tab", contexts(READER_CONTEXTS)),
  descriptor("tab.previous", "Previous Tab", contexts(READER_CONTEXTS)),

  descriptor("scroll.left", "Scroll Left", contexts(READER_CONTEXTS), "allowed"),
  descriptor("scroll.down", "Scroll Down", contexts(READER_CONTEXTS), "allowed"),
  descriptor("scroll.up", "Scroll Up", contexts(READER_CONTEXTS), "allowed"),
  descriptor("scroll.right", "Scroll Right", contexts(READER_CONTEXTS), "allowed"),
  descriptor("scroll.largeDown", "Scroll Down by Viewport", contexts(READER_CONTEXTS), "allowed"),
  descriptor("scroll.largeUp", "Scroll Up by Viewport", contexts(READER_CONTEXTS), "allowed"),

  descriptor("page.next", "Next Page", contexts(READER_CONTEXTS), "allowed"),
  descriptor("page.previous", "Previous Page", contexts(READER_CONTEXTS), "allowed"),
  descriptor("page.first", "First Page", contexts(READER_CONTEXTS)),
  descriptor("page.last", "Last Page", contexts(READER_CONTEXTS)),
  descriptor("page.prompt", "Go to Page…", contexts(READER_CONTEXTS)),
  descriptor("history.back", "Back", contexts(NAVIGATION_CONTEXT)),
  descriptor("history.forward", "Forward", contexts(NAVIGATION_CONTEXT)),

  descriptor("prompt.commit", "Commit Prompt", contexts(PROMPT_CONTEXTS), "suppressed", "fixed"),
  descriptor("prompt.cancel", "Cancel Prompt", contexts(PROMPT_CONTEXTS), "suppressed", "fixed"),
  descriptor("search.prompt", "Find…", contexts(READER_CONTEXTS)),
  descriptor("search.next", "Next Match", contexts(SEARCH_RESULTS_CONTEXT), "allowed", "fixed"),
  descriptor("search.previous", "Previous Match", contexts(SEARCH_RESULTS_CONTEXT), "allowed", "fixed"),
  descriptor("search.cancel", "Clear Search", contexts(SEARCH_RESULTS_CONTEXT)),

  descriptor("view.zoomIn", "Zoom In", contexts(READER_CONTEXTS), "allowed"),
  descriptor("view.zoomOut", "Zoom Out", contexts(READER_CONTEXTS), "allowed"),
  descriptor("view.zoomReset", "Actual Size", contexts(READER_CONTEXTS)),
  descriptor("view.fitWidth", "Fit Width", contexts(READER_CONTEXTS)),
  descriptor("view.fitPage", "Fit Page", contexts(READER_CONTEXTS)),
  descriptor("view.rotateLeft", "Rotate Left", contexts(READER_CONTEXTS)),
  descriptor("view.rotateRight", "Rotate Right", contexts(READER_CONTEXTS)),
  descriptor("config.reload", "Reload Config", contexts(NAVIGATION_CONTEXT)),
  descriptor("config.writeDefault", "Write Default Config", GLOBAL),
  descriptor("config.resetDefault", "Reset Config", GLOBAL),
  descriptor("theme.picker", "Theme picker", contexts(READER_CONTEXTS)),
  descriptor("update.show", "View Available Update", contexts(READER_CONTEXTS)),
  descriptor("path.showParent", "Show PDF Path", contexts(NAVIGATION_CONTEXT)),
  descriptor("path.copy", "Copy PDF Path", contexts(NAVIGATION_CONTEXT)),

]);

const DESCRIPTOR_BY_ID: ReadonlyMap<ActionId, ActionDescriptor> = new Map(
  ACTION_DESCRIPTORS.map((action) => [action.id, action]),
);

export const FIXED_ACTION_IDS: readonly ActionId[] = Object.freeze(
  ACTION_DESCRIPTORS
    .filter((action) => action.bindingConfiguration === "fixed")
    .map((action) => action.id),
);

export const CONFIGURABLE_ACTION_DESCRIPTORS: readonly ActionDescriptor[] = Object.freeze(
  ACTION_DESCRIPTORS.filter((action) => action.bindingConfiguration === "configurable"),
);

export function getActionDescriptor(id: ActionId): ActionDescriptor | undefined {
  return DESCRIPTOR_BY_ID.get(id);
}

export function isActionAvailable(id: ActionId, context: InputContext): boolean {
  const availability = DESCRIPTOR_BY_ID.get(id)?.availability;
  return availability?.kind === "global" || availability?.contexts.includes(context) === true;
}

export interface ActionRuntimeContext {
  readonly hasDocument: boolean;
  readonly canOpenDocument: boolean;
  readonly canCreateSession: boolean;
  readonly canCreateWindow: boolean;
  readonly tabCount: number;
  readonly modalOpen: boolean;
  readonly updateAvailable: boolean;
  readonly configExists: boolean;
  readonly searchActive: boolean;
  readonly canHistoryBack: boolean;
  readonly canHistoryForward: boolean;
  readonly implementedActionIds?: ReadonlySet<ActionId>;
}

export type ActionRuntimeAvailability =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: string };

const DOCUMENT_ACTIONS = new Set<ActionId>([
  "document.close", "document.print", "tab.next", "tab.previous",
  ...ACTION_IDS.filter((id) => id.startsWith("scroll.")),
  ...ACTION_IDS.filter((id) => id.startsWith("page.")),
  "history.back", "history.forward", "search.prompt", "search.next", "search.previous", "search.cancel", "path.showParent", "path.copy",
  ...ACTION_IDS.filter((id) => id.startsWith("view.")),
]);

/** Runtime availability used by menu/palette/help projections; input-context routing is checked separately. */
export function getActionRuntimeAvailability(id: ActionId, state: ActionRuntimeContext): ActionRuntimeAvailability {
  if (state.modalOpen && id !== "prompt.commit" && id !== "prompt.cancel" && id !== "app.quit") {
    return { enabled: false, reason: "Close the current dialog" };
  }
  if (state.implementedActionIds !== undefined && !state.implementedActionIds.has(id)) {
    return { enabled: false, reason: "Not available in this workstream" };
  }
  if (id === "document.open" && (!state.canOpenDocument || !state.canCreateSession)) {
    return { enabled: false, reason: "Document capacity unavailable" };
  }
  if (id === "app.new" && !state.canCreateWindow) return { enabled: false, reason: "Window capacity unavailable" };
  if (DOCUMENT_ACTIONS.has(id) && !state.hasDocument) return { enabled: false, reason: "No document open" };
  if ((id === "tab.next" || id === "tab.previous") && state.tabCount < 2) return { enabled: false, reason: "Only one tab open" };
  if (id === "config.writeDefault" && state.configExists) return { enabled: false, reason: "Config already exists" };
  if (id === "config.resetDefault" && !state.configExists) return { enabled: false, reason: "No config to reset" };
  if ((id === "search.next" || id === "search.previous" || id === "search.cancel") && !state.searchActive) return { enabled: false, reason: "No active search" };
  if (id === "history.back" && !state.canHistoryBack) return { enabled: false, reason: "No back history" };
  if (id === "history.forward" && !state.canHistoryForward) return { enabled: false, reason: "No forward history" };
  if (id === "update.show" && !state.updateAvailable) return { enabled: false, reason: "No update available" };
  return { enabled: true };
}
