import { projectShellStatus, type ShellStatusInput } from "./ShellProjection";

export interface PathNotice {
  readonly text: string;
  readonly copied: boolean;
}

/** Owns the footer children; pending input never replaces the active diagnostic. */
export function createShellStatusRenderer(
  footer: HTMLElement,
  readActiveStatus: () => Omit<ShellStatusInput, "pendingSequence">,
): { render: () => void; setPendingSequence: (sequence: string) => void; setPathNotice: (notice: PathNotice | undefined) => void } {
  const span = (className: string, text = ""): HTMLSpanElement => {
    const node = footer.ownerDocument.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  };
  const message = span("status-message");
  const fitPage = span("status-badge status-badge-fit-page", "FIT PAGE");
  const fitWidth = span("status-badge status-badge-fit-width", "FIT WIDTH");
  const search = span("status-badge status-badge-search", "SEARCH");
  const pending = span("status-pending");
  const pathNotice = span("status-path-notice");
  fitPage.hidden = fitWidth.hidden = search.hidden = pending.hidden = pathNotice.hidden = true;
  footer.replaceChildren(message, " ", fitPage, " ", fitWidth, " ", search, " ", pending, " ", pathNotice);
  let pendingSequence = "";
  let pathNoticeValue: PathNotice | undefined;
  const render = (): void => {
    const state = projectShellStatus({ ...readActiveStatus(), pendingSequence });
    if (message.textContent !== state.message) message.textContent = state.message;
    if (pending.textContent !== state.pending) pending.textContent = state.pending;
    if (fitPage.hidden === state.fitPage) fitPage.hidden = !state.fitPage;
    if (fitWidth.hidden === state.fitWidth) fitWidth.hidden = !state.fitWidth;
    if (search.hidden === state.search) search.hidden = !state.search;
    const pendingHidden = state.pending.length === 0;
    if (pending.hidden !== pendingHidden) pending.hidden = pendingHidden;
    const notice = pathNoticeValue;
    const noticeHidden = notice === undefined;
    if (pathNotice.hidden !== noticeHidden) pathNotice.hidden = noticeHidden;
    if (notice !== undefined) {
      const text = `${notice.text}${notice.copied ? " Copied!" : ""}`;
      if (pathNotice.textContent !== text) {
        const copied = notice.copied ? span("status-path-notice-copied", "Copied!") : undefined;
        pathNotice.replaceChildren(notice.text, ...(copied === undefined ? [] : [" ", copied]));
      }
    }
  };
  return {
    render,
    setPendingSequence: (sequence) => { pendingSequence = sequence; render(); },
    setPathNotice: (notice) => { pathNoticeValue = notice; render(); },
  };
}
