import type { ThemeId } from "../domain/theme/Theme";
const MAX_COUNT = 1_000_000;
const MIN_ZOOM_PERCENT = 10;
const MAX_ZOOM_PERCENT = 1_000;

export type ThemeAnnouncementId = ThemeId;
export type SafeStatus = "ready" | "document-closed" | "render-complete" | "search-cleared";

export type SafeError =
  | "document-unavailable"
  | "document-invalid"
  | "document-password-required"
  | "document-password-rejected"
  | "document-locality-denied"
  | "render-failed"
  | "theme-save-failed"
  | "open-picker-service"
  | "open-request-admission"
  | "open-adoption"
  | "open-presentation"
  | "open-ownership-capacity"
  | "open-unknown";

export type AccessibilityAnnouncement =
  | { readonly kind: "page"; readonly generation: number; readonly page: number; readonly pageCount: number }
  | { readonly kind: "zoom"; readonly generation: number; readonly zoomPercent: number }
  | { readonly kind: "status"; readonly generation: number; readonly status: SafeStatus }
  | { readonly kind: "loading-complete"; readonly generation: number; readonly pageCount: number }
  | { readonly kind: "tab"; readonly active: number; readonly total: number }
  | { readonly kind: "search"; readonly generation: number; readonly current: number; readonly total: number }
  | { readonly kind: "palette"; readonly open: boolean }
  | { readonly kind: "theme"; readonly themeId: ThemeAnnouncementId }
  | { readonly kind: "error"; readonly error: SafeError };

export interface AccessibilityAnnouncementTarget {
  readonly polite: HTMLElement;
  readonly assertive: HTMLElement;
}

export interface AccessibilityControllerOptions {
  readonly target: AccessibilityAnnouncementTarget;
  readonly generation?: number;
}

export interface TabAccessibilityInput {
  readonly basename: string;
  readonly ordinal: number;
  readonly total: number;
  readonly active: boolean;
}

export interface TabAccessibilitySemantics {
  readonly role: "tab";
  readonly ariaLabel: string;
  readonly ariaSelected: "true" | "false";
  readonly ariaSetSize: number;
  readonly ariaPosInSet: number;
  readonly tabIndex: 0 | -1;
}

interface PageZoomState {
  readonly generation: number;
  readonly page?: number;
  readonly pageCount?: number;
  readonly zoomPercent?: number;
}
const STATUS_TEXT: Readonly<Record<SafeStatus, string>> = {
  ready: "Ready.",
  "document-closed": "Document closed.",
  "render-complete": "Page rendered.",
  "search-cleared": "Search cleared.",
};

const ERROR_TEXT: Readonly<Record<SafeError, string>> = {
  "document-unavailable": "Document is unavailable.",
  "document-invalid": "Document cannot be opened.",
  "document-password-required": "A password is required to open this document.",
  "document-password-rejected": "The password was not accepted.",
  "document-locality-denied": "This document location is not supported.",
  "render-failed": "The page could not be rendered.",
  "theme-save-failed": "The theme could not be saved.",
  "open-picker-service": "Could not open PDF. [OPEN_PICKER_SERVICE]",
  "open-request-admission": "Could not open PDF. [OPEN_REQUEST_ADMISSION]",
  "open-adoption": "Could not open PDF. [OPEN_ADOPTION]",
  "open-presentation": "Could not open PDF. [OPEN_PRESENTATION]",
  "open-ownership-capacity": "Could not open PDF. [OPEN_OWNERSHIP_CAPACITY]",
  "open-unknown": "Could not open PDF. [OPEN_UNKNOWN]",
};

const THEME_TEXT: Readonly<Record<ThemeAnnouncementId, string>> = {
  "tokyo-night": "Theme changed to Tokyo Night.",
  "gruvbox-dark": "Theme changed to Gruvbox Dark.",
  "solarized-dark": "Theme changed to Solarized Dark.",
  dracula: "Theme changed to Dracula.",
  everforest: "Theme changed to Everforest.",
  nord: "Theme changed to Nord.",
  "catppuccin-latte": "Theme changed to Catppuccin Latte.",
};

function isCount(value: number, allowZero = false): boolean {
  return Number.isSafeInteger(value) && value <= MAX_COUNT && (allowZero ? value >= 0 : value > 0);
}

function isGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isThemeId(value: string): value is ThemeAnnouncementId {
  return Object.hasOwn(THEME_TEXT, value);
}

function hasCurrentGeneration(announcement: AccessibilityAnnouncement): announcement is Exclude<AccessibilityAnnouncement,
  { readonly kind: "tab" } | { readonly kind: "palette" } | { readonly kind: "theme" } | { readonly kind: "error" }
> {
  return "generation" in announcement;
}

/**
 * Accept only a file-like display name. Path, URL, query, and control-character
 * values deliberately collapse to a generic name before entering accessible DOM.
 */
export function safeDocumentBasename(value: string): string {
  if (
    value.length === 0
    || value.length > 255
    || /[\\/:?\u0000-\u001F\u007F]/u.test(value)
    || value.includes("://")
  ) return "PDF document";
  return value;
}

export function tabAccessibilitySemantics(input: TabAccessibilityInput): TabAccessibilitySemantics {
  const total = isCount(input.total) ? input.total : 1;
  const ordinal = isCount(input.ordinal) && input.ordinal <= total ? input.ordinal : 1;
  const basename = safeDocumentBasename(input.basename);
  return {
    role: "tab",
    ariaLabel: `${basename}, tab ${ordinal} of ${total}`,
    ariaSelected: String(input.active) as "true" | "false",
    ariaSetSize: total,
    ariaPosInSet: ordinal,
    tabIndex: input.active ? 0 : -1,
  };
}

export function readerAccessibilityName(basename: string, pageCount: number): string {
  const count = isCount(pageCount) ? pageCount : 0;
  return count === 0
    ? `${safeDocumentBasename(basename)} reader`
    : `${safeDocumentBasename(basename)} reader, ${count} pages`;
}

export function visualPageAccessibilityName(page: number, pageCount: number): string {
  const total = isCount(pageCount) ? pageCount : 1;
  const current = isCount(page) && page <= total ? page : 1;
  return `PDF page ${current} of ${total}`;
}

/** Returns the deterministic focus target after an overlay closes. */
export function focusRestoreTarget(
  invoker: HTMLElement | null,
  activeTab: HTMLElement | null,
  reader: HTMLElement | null,
): HTMLElement | null {
  if (invoker?.isConnected) return invoker;
  if (activeTab?.isConnected) return activeTab;
  return reader?.isConnected ? reader : null;
}

export class AccessibilityController {
  private generation: number;
  private pendingPageZoom: PageZoomState | undefined;
  private scheduled = false;
  private lastPolite: string | undefined;
  private lastAssertive: string | undefined;
  private activeTabKey = "initial";

  public constructor(private readonly options: AccessibilityControllerOptions) {
    this.generation = options.generation ?? 0;
    options.target.polite.setAttribute("aria-live", "polite");
    options.target.polite.setAttribute("aria-atomic", "true");
    options.target.assertive.setAttribute("aria-live", "assertive");
    options.target.assertive.setAttribute("aria-atomic", "true");
  }

  /** Starts a newer document generation and drops queued output from earlier renders. */
  public setGeneration(generation: number): boolean {
    if (!isGeneration(generation) || generation < this.generation) return false;
    this.generation = generation;
    if (this.pendingPageZoom?.generation !== generation) this.pendingPageZoom = undefined;
    return true;
  }
  /** Activates a tab-local document generation, allowing lower generations across tabs. */
  public activateTab(tabKey: string, generation: number): boolean {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(tabKey) || !isGeneration(generation)) return false;
    if (tabKey === this.activeTabKey) return this.setGeneration(generation);
    this.activeTabKey = tabKey;
    this.generation = generation;
    this.pendingPageZoom = undefined;
    this.lastPolite = undefined;
    this.lastAssertive = undefined;
    return true;
  }

  /** Queues or emits a finite, redacted announcement. Returns false for stale or invalid input. */
  public announce(announcement: AccessibilityAnnouncement): boolean {
    if (!this.isValid(announcement)) return false;
    if (hasCurrentGeneration(announcement) && announcement.generation !== this.generation) return false;

    if (announcement.kind === "page" || announcement.kind === "zoom") {
      const pending = this.pendingPageZoom?.generation === this.generation
        ? this.pendingPageZoom
        : { generation: this.generation };
      this.pendingPageZoom = announcement.kind === "page"
        ? { ...pending, page: announcement.page, pageCount: announcement.pageCount }
        : { ...pending, zoomPercent: announcement.zoomPercent };
      this.scheduleFlush();
      return true;
    }

    this.flush();
    if (announcement.kind === "error") this.write("assertive", ERROR_TEXT[announcement.error]);
    else this.write("polite", this.messageFor(announcement));
    return true;
  }

  /** Flushes a coalesced committed page/zoom update; useful at render commit boundaries. */
  public flush(): void {
    this.scheduled = false;
    const pending = this.pendingPageZoom;
    this.pendingPageZoom = undefined;
    if (!pending || pending.generation !== this.generation) return;
    if (pending.page !== undefined && pending.pageCount !== undefined && pending.zoomPercent !== undefined) {
      this.write("polite", `Page ${pending.page} of ${pending.pageCount}, zoom ${pending.zoomPercent}%.`);
    } else if (pending.page !== undefined && pending.pageCount !== undefined) {
      this.write("polite", `Page ${pending.page} of ${pending.pageCount}.`);
    } else if (pending.zoomPercent !== undefined) {
      this.write("polite", `Zoom ${pending.zoomPercent}%.`);
    }
  }

  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private write(channel: "polite" | "assertive", message: string): void {
    const previous = channel === "polite" ? this.lastPolite : this.lastAssertive;
    if (message === previous) return;
    this.options.target[channel].textContent = message;
    if (channel === "polite") this.lastPolite = message;
    else this.lastAssertive = message;
  }

  private messageFor(announcement: Exclude<AccessibilityAnnouncement,
    { readonly kind: "page" } | { readonly kind: "zoom" } | { readonly kind: "error" }
  >): string {
    switch (announcement.kind) {
      case "status": return STATUS_TEXT[announcement.status];
      case "loading-complete": return `Document loaded, ${announcement.pageCount} pages.`;
      case "tab": return `Tab ${announcement.active} of ${announcement.total}.`;
      case "search": return announcement.total === 0
        ? "No search results."
        : `Search result ${announcement.current} of ${announcement.total}.`;
      case "palette": return announcement.open ? "Command palette opened." : "Command palette closed.";
      case "theme": return THEME_TEXT[announcement.themeId];
    }
  }

  private isValid(announcement: AccessibilityAnnouncement): boolean {
    switch (announcement.kind) {
      case "page": return isGeneration(announcement.generation) && isCount(announcement.page) && isCount(announcement.pageCount) && announcement.page <= announcement.pageCount;
      case "zoom": return isGeneration(announcement.generation) && Number.isSafeInteger(announcement.zoomPercent) && announcement.zoomPercent >= MIN_ZOOM_PERCENT && announcement.zoomPercent <= MAX_ZOOM_PERCENT;
      case "status": return isGeneration(announcement.generation) && Object.hasOwn(STATUS_TEXT, announcement.status);
      case "loading-complete": return isGeneration(announcement.generation) && isCount(announcement.pageCount);
      case "tab": return isCount(announcement.total) && isCount(announcement.active) && announcement.active <= announcement.total;
      case "search": return isGeneration(announcement.generation) && isCount(announcement.total, true) && (announcement.total === 0 ? announcement.current === 0 : isCount(announcement.current) && announcement.current <= announcement.total);
      case "palette": return typeof announcement.open === "boolean";
      case "theme": return isThemeId(announcement.themeId);
      case "error": return Object.hasOwn(ERROR_TEXT, announcement.error);
    }
  }
}
