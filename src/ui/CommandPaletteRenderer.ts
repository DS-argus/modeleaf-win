import type { CommandPaletteCommandEntry } from "./CommandPaletteModel";

/** Command indices remain shared with keyboard routing. */
export function renderCommandPalette(
  list: HTMLElement,
  entries: readonly CommandPaletteCommandEntry[],
  selectedIndex: number,
  onActivate: (index: number) => void,
): void {
  const children: HTMLElement[] = [];
  entries.forEach((entry, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "overlay-list-entry command-palette-entry";
    button.setAttribute("aria-selected", String(index === selectedIndex));
    button.setAttribute("aria-disabled", String(!entry.enabled));
    const label = document.createElement("span");
    label.className = "command-palette-entry-label";
    label.textContent = entry.label;
    const shortcut = document.createElement("span");
    shortcut.className = "command-palette-entry-shortcut";
    shortcut.textContent = entry.shortcut;
    button.append(label, shortcut);
    if (!entry.enabled && entry.disabledReason !== undefined) {
      const reason = document.createElement("span");
      reason.className = "command-palette-entry-reason";
      reason.textContent = entry.disabledReason;
      button.setAttribute("aria-description", entry.disabledReason);
      button.append(reason);
    }
    button.addEventListener("click", () => onActivate(index));
    item.append(button);
    children.push(item);
  });
  list.replaceChildren(...children);
  if (selectedIndex === 0) list.scrollTop = 0;
}
