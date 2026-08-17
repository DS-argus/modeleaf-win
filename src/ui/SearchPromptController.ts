type PromptKeyAction = "close" | "search";
function isNativePromptInput(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || event.key === "Dead" || event.key === "Process" || event.key === "Unidentified" || event.getModifierState("AltGraph") || event.altKey || event.metaKey || (event.ctrlKey && event.altKey);
}
function promptKeyAction(event: KeyboardEvent): PromptKeyAction | undefined {
  if (isNativePromptInput(event) || event.ctrlKey || (event.key === "Escape" && event.shiftKey)) return undefined;
  if (event.key === "Escape") return "close";
  if (event.key === "Enter") return "search";
  return undefined;
}
export interface SearchPromptSession {
  startSearch(query: string): { readonly kind: "search" | "ignore" | "cycle" };
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
  const onSubmit = (event: SubmitEvent): void => event.preventDefault();
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isNativePromptInput(event)) return;
    const action = promptKeyAction(event);
    if (action === "close") {
      event.preventDefault();
      elements.dialog.close();
      render();
      return;
    }
    if (action === "search") {
      event.preventDefault();
      const decision = getSession().startSearch(elements.input.value);
      if (decision.kind === "search") elements.dialog.close();
      render();
    }
  };

  elements.form.addEventListener("submit", onSubmit);
  elements.input.addEventListener("keydown", onKeyDown);
  return () => {
    elements.form.removeEventListener("submit", onSubmit);
    elements.input.removeEventListener("keydown", onKeyDown);
  };
}
