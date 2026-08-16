import type { OutlineRow } from "./OutlineModel";

export const OUTLINE_INPUT_TIMEOUT_MS = 400;
export type OutlineInputResult =
  | { readonly kind: "pending"; readonly buffer: string; readonly deadline: number }
  | { readonly kind: "selected"; readonly row: OutlineRow }
  | { readonly kind: "invalid" }
  | { readonly kind: "cancelled" };

export class OutlineSelectorInput {
  private buffer = "";
  private deadline: number | undefined;

  public constructor(private readonly rows: readonly OutlineRow[]) {}

  public append(key: string, now: number): OutlineInputResult {
    if (this.deadline !== undefined && now >= this.deadline) this.reset();
    if (!/^[0-9]$/u.test(key)) return { kind: "invalid" };
    this.buffer += key;
    const exact = this.rows.find((row) => row.enabled && row.selector === this.buffer);
    const longer = this.rows.some((row) => row.enabled && row.selector?.startsWith(this.buffer) && row.selector !== this.buffer);
    if (exact !== undefined && !longer) { this.reset(); return { kind: "selected", row: exact }; }
    if (exact === undefined && !longer) { this.reset(); return { kind: "invalid" }; }
    this.deadline = now + OUTLINE_INPUT_TIMEOUT_MS;
    return { kind: "pending", buffer: this.buffer, deadline: this.deadline };
  }

  public backspace(now: number): OutlineInputResult {
    if (this.deadline !== undefined && now >= this.deadline) this.reset();
    if (this.buffer.length === 0) return { kind: "invalid" };
    this.buffer = this.buffer.slice(0, -1);
    if (this.buffer.length === 0) { this.reset(); return { kind: "cancelled" }; }
    this.deadline = now + OUTLINE_INPUT_TIMEOUT_MS;
    return { kind: "pending", buffer: this.buffer, deadline: this.deadline };
  }

  public expire(now: number): OutlineInputResult {
    if (this.deadline === undefined) return { kind: "cancelled" };
    if (now < this.deadline) return { kind: "pending", buffer: this.buffer, deadline: this.deadline };
    const exact = this.rows.find((row) => row.enabled && row.selector === this.buffer);
    this.reset();
    return exact === undefined ? { kind: "cancelled" } : { kind: "selected", row: exact };
  }

  public cancel(): OutlineInputResult { this.reset(); return { kind: "cancelled" }; }
  public state(): Readonly<{ buffer: string; deadline?: number }> {
    return Object.freeze({ buffer: this.buffer, ...(this.deadline === undefined ? {} : { deadline: this.deadline }) });
  }
  private reset(): void { this.buffer = ""; this.deadline = undefined; }
}
