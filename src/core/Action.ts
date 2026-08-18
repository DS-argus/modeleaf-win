export type Action =
  | { readonly type: "document.open" }
  | { readonly type: "document.print" }
  | { readonly type: "page.next" }
  | { readonly type: "page.previous" }
  | { readonly type: "page.first" }
  | { readonly type: "page.last" }
  | { readonly type: "page.goTo"; readonly page: number }
  | {
    readonly type: "scroll.byCssPixels";
    readonly axis: "horizontal" | "vertical";
    readonly delta: number;
  }
  | { readonly type: "scroll.byViewport"; readonly factor: number }
  | { readonly type: "view.fitWidth" }
  | { readonly type: "view.fitPage" }
  | { readonly type: "view.zoom"; readonly factor: number }
  | { readonly type: "view.actualSize" }
  | { readonly type: "view.rotate"; readonly quarterTurns: 1 | -1 }
  | { readonly type: "application.new" }
  | { readonly type: "palette.toggle" }
  | { readonly type: "toc.toggle" }
  | { readonly type: "toc.scrollDown" }
  | { readonly type: "toc.scrollUp" }
  | { readonly type: "tab.close" }
  | { readonly type: "tab.activate"; readonly index: number }
  | { readonly type: "tab.next" }
  | { readonly type: "tab.previous" }
  | { readonly type: "theme.open" }
  | { readonly type: "config.reload" }
  | { readonly type: "indicator.open" }
  | { readonly type: "update.show" }
  | { readonly type: "application.quit" }
  | { readonly type: "search.open" }
  | { readonly type: "linkHints.toggle" }
  | { readonly type: "help.toggle" }
  | { readonly type: "prompt.open" }
  | { readonly type: "prompt.cancel" };

export type ActionType = Action["type"];

export interface ActionDispatch {
  readonly action: Action;
  readonly source: "binding" | "sequence" | "prompt" | "timeout";
}
