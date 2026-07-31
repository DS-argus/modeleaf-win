export type Action =
  | { readonly type: "document.open" }
  | { readonly type: "page.next" }
  | { readonly type: "page.previous" }
  | { readonly type: "page.first" }
  | { readonly type: "page.last" }
  | { readonly type: "page.goTo"; readonly page: number }
  | { readonly type: "help.toggle" }
  | { readonly type: "prompt.open" }
  | { readonly type: "prompt.cancel" };

export type ActionType = Action["type"];

export interface ActionDispatch {
  readonly action: Action;
  readonly source: "binding" | "sequence" | "prompt" | "timeout";
}
