export interface KeyToken {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly repeat: boolean;
}

export function token(
  key: string,
  modifiers: Partial<Omit<KeyToken, "key">> = {},
): KeyToken {
  return {
    key,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    meta: modifiers.meta ?? false,
    repeat: modifiers.repeat ?? false,
  };
}

export function tokenSignature(value: KeyToken): string {
  const key = value.ctrl && value.key.length === 1
    ? value.key.toLowerCase()
    : value.key;
  return `${value.ctrl ? "C-" : ""}${value.alt ? "A-" : ""}${value.meta ? "M-" : ""}${key}`;
}
