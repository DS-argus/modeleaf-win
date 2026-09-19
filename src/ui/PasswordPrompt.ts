export type PasswordPromptReason = "required" | "incorrect";

export interface PasswordPromptRequest {
  readonly reason: PasswordPromptReason;
  readonly signal: AbortSignal;
}

export interface PasswordPromptOptions {
  readonly onCancel?: () => void;
}

export interface PasswordPrompt {
  readonly active: boolean;
  request(request: PasswordPromptRequest): Promise<string | null>;
  dismiss(): void;
  dispose(): void;
}

interface PendingRequest {
  readonly generation: number;
  readonly resolve: (value: string | null) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing
    || event.keyCode === 229
    || event.key === "Dead"
    || event.key === "Process"
    || event.key === "Unidentified"
    || event.getModifierState("AltGraph");
}

/** Owns the single modal password challenge used while opening a protected document. */
export function createPasswordPrompt(options: PasswordPromptOptions = {}): PasswordPrompt {
  const ownerDocument = document;
  const dialog = ownerDocument.createElement("dialog");
  dialog.id = "password-dialog";
  dialog.className = "password-prompt";
  dialog.setAttribute("aria-label", "Enter the password");

  const form = ownerDocument.createElement("form");
  form.autocomplete = "off";

  const label = ownerDocument.createElement("label");
  label.htmlFor = "password-input";
  label.textContent = "Enter the password";

  const input = ownerDocument.createElement("input");
  input.id = "password-input";
  input.type = "password";
  input.name = "password";
  input.autocomplete = "off";

  const error = ownerDocument.createElement("p");
  error.id = "password-error";
  error.className = "password-prompt-error";
  error.textContent = "Incorrect password";
  error.hidden = true;

  const actions = ownerDocument.createElement("menu");
  actions.className = "password-prompt-actions";

  const open = ownerDocument.createElement("button");
  open.id = "password-open";
  open.type = "submit";
  open.textContent = "Open";

  const cancel = ownerDocument.createElement("button");
  cancel.id = "password-cancel";
  cancel.type = "button";
  cancel.textContent = "Cancel";

  actions.append(open, cancel);
  form.append(label, input, error, actions);
  dialog.append(form);
  ownerDocument.body.append(dialog);

  let disposed = false;
  let visible = false;
  let generation = 0;
  let pending: PendingRequest | undefined;
  let restoreFocus: HTMLElement | SVGElement | null = null;
  let composing = false;
  let suppressNextSubmit = false;

  const clearInput = (): void => {
    input.value = "";
  };

  const clearError = (): void => {
    error.hidden = true;
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
  };

  const showError = (): void => {
    error.hidden = false;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", error.id);
  };

  const removeAbortListener = (request: PendingRequest): void => {
    request.signal.removeEventListener("abort", request.onAbort);
  };

  const restorePreviousFocus = (): void => {
    const target = restoreFocus;
    restoreFocus = null;
    if (target !== null && target.isConnected) target.focus();
  };

  const closeDialog = (): void => {
    if (!visible) return;
    visible = false;
    dialog.close();
    dialog.removeAttribute("open");
    restorePreviousFocus();
  };

  const settlePending = (value: string | null): void => {
    const request = pending;
    if (request === undefined) return;
    pending = undefined;
    removeAbortListener(request);
    request.resolve(value);
  };

  const terminalDismiss = (): void => {
    generation += 1;
    composing = false;
    suppressNextSubmit = false;
    settlePending(null);
    clearInput();
    clearError();
    input.disabled = true;
    open.disabled = true;
    closeDialog();
  };

  const explicitCancel = (): void => {
    if (disposed || !visible) return;
    terminalDismiss();
    options.onCancel?.();
  };

  const showDialog = (): void => {
    if (visible) return;
    const focused = ownerDocument.activeElement;
    restoreFocus = focused instanceof HTMLElement || focused instanceof SVGElement ? focused : null;
    dialog.showModal();
    visible = true;
  };

  const focusInput = (): void => {
    input.focus();
  };

  const submit = (): void => {
    if (disposed || !visible || open.disabled) return;
    const request = pending;
    if (request === undefined) return;

    pending = undefined;
    removeAbortListener(request);
    const password = input.value;
    clearInput();
    input.disabled = true;
    open.disabled = true;
    cancel.focus();
    request.resolve(password);
  };

  const onSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (composing || suppressNextSubmit) {
      suppressNextSubmit = false;
      return;
    }
    submit();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Tab" && !composing && !isComposing(event)) {
      event.preventDefault();
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      const controls = [input, open, cancel].filter((control) => !control.disabled);
      const index = controls.findIndex((control) => control === ownerDocument.activeElement);
      const next = (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
      controls[next]?.focus();
      return;
    }
    if (event.key === "Escape") {
      if (composing || isComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      explicitCancel();
      return;
    }
    if (event.key !== "Enter" || event.target !== input) return;
    if (composing || isComposing(event)) {
      event.preventDefault();
      suppressNextSubmit = true;
      return;
    }
    suppressNextSubmit = false;
    event.preventDefault();
    submit();
  };

  const onCancel = (event: Event): void => {
    event.preventDefault();
    explicitCancel();
  };

  const onCancelButton = (): void => {
    explicitCancel();
  };

  const onOpenClick = (): void => {
    suppressNextSubmit = false;
  };

  const onCompositionStart = (): void => {
    composing = true;
    suppressNextSubmit = false;
  };

  const onCompositionEnd = (): void => {
    composing = false;
    suppressNextSubmit = false;
  };

  form.addEventListener("submit", onSubmit);
  dialog.addEventListener("keydown", onKeyDown);
  dialog.addEventListener("cancel", onCancel);
  cancel.addEventListener("click", onCancelButton);
  open.addEventListener("click", onOpenClick);
  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);

  const prompt: PasswordPrompt = {
    get active(): boolean {
      return visible && !disposed;
    },
    request(request: PasswordPromptRequest): Promise<string | null> {
      if (disposed || request.signal.aborted) return Promise.resolve(null);

      generation += 1;
      settlePending(null);
      showDialog();
      clearInput();
      composing = false;
      suppressNextSubmit = false;
      input.disabled = false;
      open.disabled = false;
      if (request.reason === "incorrect") showError();
      else clearError();
      focusInput();

      return new Promise<string | null>((resolve) => {
        const requestGeneration = generation;
        const onAbort = (): void => {
          if (generation !== requestGeneration || pending?.generation !== requestGeneration) return;
          terminalDismiss();
        };
        const current: PendingRequest = { generation: requestGeneration, resolve, signal: request.signal, onAbort };
        pending = current;
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) onAbort();
      });
    },
    dismiss(): void {
      if (disposed) return;
      terminalDismiss();
    },
    dispose(): void {
      if (disposed) return;
      terminalDismiss();
      disposed = true;
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("keydown", onKeyDown);
      dialog.removeEventListener("cancel", onCancel);
      cancel.removeEventListener("click", onCancelButton);
      open.removeEventListener("click", onOpenClick);
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      dialog.remove();
      restoreFocus = null;
    },
  };

  return prompt;
}
