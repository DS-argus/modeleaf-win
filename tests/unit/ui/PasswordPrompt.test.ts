/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { createPasswordPrompt } from "../../../src/ui/PasswordPrompt";

function setup(onCancel: () => void = vi.fn()) {
  const invoker = document.createElement("button");
  invoker.textContent = "Open PDF";
  document.body.append(invoker);
  invoker.focus();

  const prompt = createPasswordPrompt({ onCancel });
  const dialog = document.querySelector<HTMLDialogElement>("#password-dialog")!;
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => dialog.removeAttribute("open"));
  const input = document.querySelector<HTMLInputElement>("#password-input")!;
  const open = document.querySelector<HTMLButtonElement>("#password-open")!;
  const cancel = document.querySelector<HTMLButtonElement>("#password-cancel")!;
  const error = document.querySelector<HTMLElement>("#password-error")!;
  return { prompt, dialog, input, open, cancel, error, invoker, onCancel };
}

function cleanup(value: ReturnType<typeof setup>): void {
  value.prompt.dispose();
  value.invoker.remove();
}

describe("createPasswordPrompt", () => {
  it("submits a password, clears the secret, and remains modal until dismissed", async () => {
    const value = setup();
    const controller = new AbortController();
    const result = value.prompt.request({ reason: "required", signal: controller.signal });
    expect(value.prompt.active).toBe(true);
    expect(value.dialog.showModal).toHaveBeenCalledOnce();
    expect(value.input.type).toBe("password");
    expect(value.input.labels?.[0]?.textContent).toBe("Enter the password");

    value.input.value = "correct horse";
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await expect(result).resolves.toBe("correct horse");
    expect(value.input.value).toBe("");
    expect(value.open.disabled).toBe(true);
    expect(value.input.disabled).toBe(true);
    expect(value.prompt.active).toBe(true);

    controller.abort();
    expect(value.prompt.active).toBe(true);
    value.prompt.dismiss();
    expect(value.prompt.active).toBe(false);
    expect(value.dialog.close).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(value.invoker);
    cleanup(value);
  });

  it("shows an incorrect attempt and allows unlimited focused retries", async () => {
    const value = setup();
    const first = value.prompt.request({ reason: "required", signal: new AbortController().signal });
    value.input.value = "wrong";
    value.open.click();
    await expect(first).resolves.toBe("wrong");

    const retryController = new AbortController();
    const retry = value.prompt.request({ reason: "incorrect", signal: retryController.signal });
    expect(value.error.hidden).toBe(false);
    expect(value.error.textContent).toBe("Incorrect password");
    expect(value.input.getAttribute("aria-describedby")).toBe("password-error");
    expect(value.input.getAttribute("aria-invalid")).toBe("true");
    expect(value.input.value).toBe("");
    expect(document.activeElement).toBe(value.input);

    value.input.value = "new password";
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await expect(retry).resolves.toBe("new password");
    expect(value.prompt.active).toBe(true);
    cleanup(value);
  });

  it("cancels pending and post-submit challenges through Escape or Cancel", async () => {
    const onCancel = vi.fn();
    const value = setup(onCancel);
    const pending = value.prompt.request({ reason: "required", signal: new AbortController().signal });
    value.cancel.click();
    await expect(pending).resolves.toBeNull();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(value.prompt.active).toBe(false);
    expect(document.activeElement).toBe(value.invoker);

    const second = value.prompt.request({ reason: "required", signal: new AbortController().signal });
    value.input.value = "submitted";
    value.open.click();
    await expect(second).resolves.toBe("submitted");
    value.dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(value.prompt.active).toBe(false);
    cleanup(value);
  });

  it("does not submit or cancel while IME composition owns Enter and Escape", async () => {
    const value = setup();
    const pending = value.prompt.request({ reason: "required", signal: new AbortController().signal });
    value.input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    const escape = new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true });
    value.input.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(value.prompt.active).toBe(true);
    const enter = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    value.input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    value.input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    value.input.value = "composed";
    value.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await expect(pending).resolves.toBe("composed");
    cleanup(value);
  });

  it("ignores stale abort callbacks, aborts pending requests, and disposes terminal state", async () => {
    const value = setup();
    const firstController = new AbortController();
    const first = value.prompt.request({ reason: "required", signal: firstController.signal });
    value.input.value = "first";
    value.open.click();
    await expect(first).resolves.toBe("first");

    const retryController = new AbortController();
    const retry = value.prompt.request({ reason: "incorrect", signal: retryController.signal });
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(value.prompt.request({ reason: "required", signal: alreadyAborted.signal })).resolves.toBeNull();
    expect(value.prompt.active).toBe(true);
    expect(value.input.disabled).toBe(false);
    firstController.abort();
    expect(value.prompt.active).toBe(true);
    expect(value.input.disabled).toBe(false);
    value.input.value = "second";
    value.open.click();
    await expect(retry).resolves.toBe("second");

    const abortController = new AbortController();
    const aborted = value.prompt.request({ reason: "required", signal: abortController.signal });
    abortController.abort();
    await expect(aborted).resolves.toBeNull();
    expect(value.prompt.active).toBe(false);
    expect(value.input.value).toBe("");

    const disposed = value.prompt.request({ reason: "required", signal: new AbortController().signal });
    value.prompt.dispose();
    await expect(disposed).resolves.toBeNull();
    expect(value.prompt.active).toBe(false);
    expect(document.querySelector("#password-dialog")).toBeNull();
    await expect(value.prompt.request({ reason: "required", signal: new AbortController().signal })).resolves.toBeNull();
    cleanup(value);
  });
});
