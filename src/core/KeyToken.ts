export interface KeyToken {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly repeat: boolean;
}

export function token(
  key: string,
  modifiers: Partial<Omit<KeyToken, "key">> = {},
): KeyToken {
  const shift = modifiers.shift ?? false;
  return {
    key: !shift && key.length === 1 ? key.toLowerCase() : key,
    ctrl: modifiers.ctrl ?? false,
    shift,
    alt: modifiers.alt ?? false,
    meta: modifiers.meta ?? false,
    repeat: modifiers.repeat ?? false,
  };
}

export function tokenSignature(value: KeyToken): string {
  const key = value.key.length === 1 && (value.ctrl || !value.shift)
    ? value.key.toLowerCase()
    : value.key;
  return `${value.ctrl ? "C-" : ""}${value.shift ? "S-" : ""}${value.alt ? "A-" : ""}${value.meta ? "M-" : ""}${key}`;
}
