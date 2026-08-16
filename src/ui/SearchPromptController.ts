type PromptKeyAction = "close" | "search" | "searchReverse";
function isNativePromptInput(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === "Dead" || event.key === "Process" || event.key === "Unidentified" || event.getModifierState("AltGraph") || event.altKey || event.metaKey || (event.ctrlKey && event.altKey);
}
function promptKeyAction(event: KeyboardEvent): PromptKeyAction | undefined {
  if (isNativePromptInput(event) || event.ctrlKey || (event.key === "Escape" && event.shiftKey)) return undefined;
  if (event.key === "Escape") return "close";
  if (event.key === "Enter") return event.shiftKey ? "searchReverse" : "search";
  return undefined;
}
export interface SearchPromptSession {
  invalidateSearch(): void;
  submitSearch(query: string, reverse: boolean): void;
}

export interface SearchPromptElements {
  readonly dialog: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly input: HTMLInputElement;
}

export function bindSearchPrompt(
  elements: SearchPromptElements,
  getSession: () => SearchPromptSession,
  render: () => void,
): () => void {
  const onInput = (): void => getSession().invalidateSearch();
  const onSubmit = (event: SubmitEvent): void => event.preventDefault();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isNativePromptInput(event)) return;
    const action = promptKeyAction(event);
    if (action === "close") {
      event.preventDefault();
      getSession().invalidateSearch();
      elements.input.value = "";
      elements.dialog.close();
      render();
      return;
    }
    if (action === "search" || action === "searchReverse") {
      event.preventDefault();
      getSession().submitSearch(elements.input.value, action === "searchReverse");
    }
  };

  elements.input.addEventListener("input", onInput);
  elements.form.addEventListener("submit", onSubmit);
  elements.input.addEventListener("keydown", onKeyDown);
  return () => {
    elements.input.removeEventListener("input", onInput);
    elements.form.removeEventListener("submit", onSubmit);
    elements.input.removeEventListener("keydown", onKeyDown);
  };
}
