import { projectShellStatus, type ShellStatusInput } from "./ShellProjection";

export interface PathNotice {
  readonly text: string;
  readonly copied: boolean;
}

export interface ShellStatusRendererOptions {
  readonly onHelp?: () => void;
}

type ShellStatusReadInput = Omit<ShellStatusInput, "pendingSequence"> & {
  readonly page?: number | undefined;
  readonly pageCount?: number | undefined;
  readonly zoom?: number | undefined;
};

interface ShellStatusRenderer {
  render: () => void;
  setPendingSequence: (sequence: string) => void;
  setPathNotice: (notice: PathNotice | undefined) => void;
  setVersion: (version: string | undefined) => void;
  printHost: HTMLElement;
}

/** Owns the footer children; pending input never replaces the active diagnostic. */
export function createShellStatusRenderer(
  footer: HTMLElement,
  readActiveStatus: () => ShellStatusReadInput,
  options?: ShellStatusRendererOptions,
): ShellStatusRenderer {
  const ownerDocument = footer.ownerDocument;
  const span = (className: string, text = ""): HTMLSpanElement => {
    const node = ownerDocument.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  };
  const setText = (node: HTMLElement, text: string): void => {
    if (node.textContent !== text) node.textContent = text;
  };
  const setHidden = (node: HTMLElement, hidden: boolean): void => {
    if (node.hidden !== hidden) node.hidden = hidden;
  };
  const setTitle = (node: HTMLElement, title: string): void => {
    if (node.title !== title) node.title = title;
  };

  footer.setAttribute("role", "group");
  footer.setAttribute("aria-label", "Reader status");
  footer.removeAttribute("aria-live");
  footer.removeAttribute("aria-atomic");

  const help = ownerDocument.createElement("button");
  help.className = "status-help";
  help.type = "button";
  help.textContent = "? help";
  if (options?.onHelp !== undefined) help.addEventListener("click", options.onHelp);

  const live = ownerDocument.createElement("span");
  live.className = "status-live";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");

  const page = span("status-page");
  const zoom = span("status-zoom");
  const metrics = span("status-metrics");
  // The coalescing AccessibilityController owns page/zoom announcements.
  metrics.setAttribute("aria-hidden", "true");
  metrics.append(page, zoom);
  const message = span("status-message");
  const fitPage = span("status-badge status-badge-fit-page", "FIT PAGE");
  const fitWidth = span("status-badge status-badge-fit-width", "FIT WIDTH");
  const search = span("status-badge status-badge-search", "SEARCH");
  const pending = span("status-pending");
  const pendingPrefix = span("visually-hidden");
  const pendingValue = span("status-pending-value");
  pending.append(pendingPrefix, pendingValue);
  const pathNotice = span("status-path-notice");
  page.hidden = zoom.hidden = fitPage.hidden = fitWidth.hidden = search.hidden = pending.hidden = pathNotice.hidden = true;
  live.replaceChildren(fitPage, fitWidth, search, pathNotice, message, pending);
  const printHost = span("status-print-host");
  printHost.setAttribute("aria-live", "polite");
  printHost.setAttribute("aria-atomic", "true");
  const version = span("status-version");
  version.hidden = true;
  let versionValue: string | undefined;
  footer.replaceChildren(help, metrics, live, printHost, version);
  let pendingSequence = "";
  let pathNoticeValue: PathNotice | undefined;
  const render = (): void => {
    const input = readActiveStatus();
    const state = projectShellStatus({ ...input, pendingSequence });
    const hasPage = input.hasDocument
      && Number.isSafeInteger(input.page)
      && Number.isSafeInteger(input.pageCount)
      && input.page !== undefined
      && input.pageCount !== undefined
      && input.page > 0
      && input.page <= input.pageCount;
    const hasZoom = input.hasDocument && input.zoomMode === "custom" && input.zoom !== undefined && Number.isFinite(input.zoom) && input.zoom > 0;
    const pageText = hasPage ? `${input.page} / ${input.pageCount}` : "";
    setText(page, pageText);
    setHidden(page, !hasPage);
    const zoomText = hasZoom ? `${Math.round((input.zoom ?? 0) * 100)}%` : "";
    setText(zoom, zoomText);
    setHidden(zoom, !hasZoom);
    setText(message, state.message);
    setHidden(message, state.message.length === 0);
    setTitle(message, state.message);
    setText(pendingValue, pendingSequence);
    setText(pendingPrefix, state.pending ? "Pending: " : "");
    setTitle(pending, state.pending);
    setHidden(fitPage, !state.fitPage);
    setHidden(fitWidth, !state.fitWidth);
    setHidden(search, !state.search);
    setHidden(pending, state.pending.length === 0);

    const notice = pathNoticeValue;
    const noticeHidden = notice === undefined;
    setHidden(pathNotice, noticeHidden);
    if (notice === undefined) {
      if (pathNotice.hasAttribute("title")) pathNotice.removeAttribute("title");
    } else {
      const text = `${notice.text}${notice.copied ? " Copied!" : ""}`;
      setTitle(pathNotice, text);
      if (pathNotice.textContent !== text) {
        const copied = notice.copied ? span("status-path-notice-copied", "Copied!") : undefined;
        pathNotice.replaceChildren(notice.text, ...(copied === undefined ? [] : [" ", copied]));
      }
    }
  };
  const setVersion = (nextVersion: string | undefined): void => {
    const normalized = nextVersion?.trim() ?? "";
    const nextValue = normalized.length === 0 ? undefined : normalized;
    if (versionValue === nextValue) return;
    versionValue = nextValue;
    if (nextValue === undefined) {
      setText(version, "");
      if (version.hasAttribute("title")) version.removeAttribute("title");
      setHidden(version, true);
      return;
    }
    setText(version, `v${nextValue}`);
    setTitle(version, `Installed Modeleaf version ${nextValue}`);
    setHidden(version, false);
  };
  return {
    render,
    setPendingSequence: (sequence) => { pendingSequence = sequence; render(); },
    setPathNotice: (notice) => { pathNoticeValue = notice; render(); },
    setVersion,
    printHost,
  };
}
