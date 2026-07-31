import type { ActionType } from "./Action";
import { token, tokenSignature, type KeyToken } from "./KeyToken";

export type BindingCommand = ActionType | "page.target" | "prompt.backspace";
export type BindingContext = "global" | "reader" | "pagePrompt";
export type BindingKind = "exact" | "prefix" | "sequence" | "digit";

export interface BindingDescriptor {
  readonly id: string;
  readonly keys: readonly string[];
  readonly label: string;
  readonly command: BindingCommand;
  readonly repeatable: boolean;
  readonly contexts: readonly BindingContext[];
  readonly kind: BindingKind;
  readonly directToken?: KeyToken;
  readonly showInHelp: boolean;
}

export const DEFAULT_BINDINGS: readonly BindingDescriptor[] = [
  {
    id: "document.open",
    keys: ["Ctrl+O"],
    label: "Open PDF",
    command: "document.open",
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("o", { ctrl: true }),
    showInHelp: true,
  },
  {
    id: "page.next",
    keys: ["n"],
    label: "Next page",
    command: "page.next",
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("n"),
    showInHelp: true,
  },
  {
    id: "page.previous",
    keys: ["p"],
    label: "Previous page",
    command: "page.previous",
    repeatable: true,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("p"),
    showInHelp: true,
  },
  {
    id: "page.target",
    keys: ["g", "digits", "Enter"],
    label: "Go to page",
    command: "page.target",
    repeatable: false,
    contexts: ["reader"],
    kind: "prefix",
    directToken: token("g"),
    showInHelp: true,
  },
  {
    id: "page.target.digit",
    keys: ["0…9"],
    label: "Enter page number",
    command: "page.target",
    repeatable: true,
    contexts: ["pagePrompt"],
    kind: "digit",
    showInHelp: false,
  },
  {
    id: "page.first",
    keys: ["g", "g"],
    label: "First page",
    command: "page.first",
    repeatable: false,
    contexts: ["reader"],
    kind: "sequence",
    showInHelp: true,
  },
  {
    id: "page.last",
    keys: ["G"],
    label: "Last page",
    command: "page.last",
    repeatable: false,
    contexts: ["reader"],
    kind: "exact",
    directToken: token("G"),
    showInHelp: true,
  },
  {
    id: "help.toggle",
    keys: ["?"],
    label: "Keyboard help",
    command: "help.toggle",
    repeatable: false,
    contexts: ["global"],
    kind: "exact",
    directToken: token("?"),
    showInHelp: true,
  },
  {
    id: "prompt.commit",
    keys: ["Enter"],
    label: "Go to entered page",
    command: "page.goTo",
    repeatable: false,
    contexts: ["pagePrompt"],
    kind: "exact",
    directToken: token("Enter"),
    showInHelp: true,
  },
  {
    id: "prompt.cancel",
    keys: ["Esc"],
    label: "Cancel prompt or close overlay",
    command: "prompt.cancel",
    repeatable: false,
    contexts: ["global", "pagePrompt"],
    kind: "exact",
    directToken: token("Escape"),
    showInHelp: true,
  },
  {
    id: "prompt.backspace",
    keys: ["Backspace"],
    label: "Delete page digit",
    command: "prompt.backspace",
    repeatable: true,
    contexts: ["pagePrompt"],
    kind: "exact",
    directToken: token("Backspace"),
    showInHelp: true,
  },
] as const;

export function bindingById(id: string): BindingDescriptor {
  const binding = DEFAULT_BINDINGS.find((candidate) => candidate.id === id);
  if (!binding) {
    throw new Error(`Unknown binding: ${id}`);
  }
  return binding;
}
export function matchesDirectToken(binding: BindingDescriptor, value: KeyToken): boolean {
  return binding.directToken !== undefined
    && tokenSignature(binding.directToken) === tokenSignature(value);
}

export function bindingAcceptsContext(
  binding: BindingDescriptor,
  context: Exclude<BindingContext, "global">,
): boolean {
  return binding.contexts.includes("global") || binding.contexts.includes(context);
}

export function findExactBinding(
  value: KeyToken,
  context: Exclude<BindingContext, "global">,
): BindingDescriptor | undefined {
  return DEFAULT_BINDINGS.find((binding) =>
    binding.kind === "exact"
    && matchesDirectToken(binding, value)
    && bindingAcceptsContext(binding, context),
  );
}

export function isPageTargetDigit(value: KeyToken): boolean {
  const binding = bindingById("page.target.digit");
  return binding.kind === "digit"
    && !value.ctrl
    && !value.alt
    && !value.meta
    && /^[0-9]$/.test(value.key);
}

export function isRegisteredCtrlChord(value: KeyToken): boolean {
  if (!value.ctrl || value.alt || value.meta) {
    return false;
  }
  return DEFAULT_BINDINGS.some((binding) =>
    binding.directToken?.ctrl === true
    && tokenSignature(binding.directToken) === tokenSignature(value),
  );
}
