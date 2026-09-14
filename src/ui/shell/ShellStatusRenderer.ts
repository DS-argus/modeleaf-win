import { projectShellStatus, type ShellStatusInput } from "./ShellProjection";

/** Owns the footer children; pending input never replaces the active diagnostic. */
export function createShellStatusRenderer(
  footer: HTMLElement,
  readActiveStatus: () => Omit<ShellStatusInput, "pendingSequence">,
): { render: () => void; setPendingSequence: (sequence: string) => void } {
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
  fitPage.hidden = fitWidth.hidden = search.hidden = pending.hidden = true;
  footer.replaceChildren(message, " ", fitPage, " ", fitWidth, " ", search, " ", pending);
  let pendingSequence = "";
  const render = (): void => {
    const state = projectShellStatus({ ...readActiveStatus(), pendingSequence });
    // Avoid re-announcing unchanged text or rebuilding badge nodes on each render.
    if (message.textContent !== state.message) message.textContent = state.message;
    if (pending.textContent !== state.pending) pending.textContent = state.pending;
    if (fitPage.hidden === state.fitPage) fitPage.hidden = !state.fitPage;
    if (fitWidth.hidden === state.fitWidth) fitWidth.hidden = !state.fitWidth;
    if (search.hidden === state.search) search.hidden = !state.search;
    const pendingHidden = state.pending.length === 0;
    if (pending.hidden !== pendingHidden) pending.hidden = pendingHidden;
  };
  return {
    render,
    setPendingSequence: (sequence) => { pendingSequence = sequence; render(); },
  };
}
