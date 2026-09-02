export interface OverlayKeyInput { readonly dialogId: string; readonly key: string; readonly ctrlKey: boolean; readonly altKey: boolean; readonly metaKey: boolean }
export function overlayOwnsKey(input: OverlayKeyInput): boolean {
  if (input.key === "Tab") return true;
  if (input.altKey || input.metaKey) return false;
  if (input.dialogId === "help-dialog") return input.key === "Escape";
  if (input.dialogId === "search-dialog") return input.key === "Escape" || input.key === "Enter";
  if (input.dialogId === "theme-dialog") {
    const key = input.key.toLocaleLowerCase();
    if (input.ctrlKey) return key === "j" || key === "k";
    return ["Escape", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(input.key) || key === "j" || key === "k";
  }
  if (input.dialogId === "command-palette-dialog" || input.dialogId === "file-opener-dialog") {
    return ["Escape", "Enter", "ArrowUp", "ArrowDown"].includes(input.key)
      || (input.ctrlKey && ["j", "k"].includes(input.key.toLocaleLowerCase()));
  }
  return false;
}
