/** Splits a text stream into newline-delimited lines, keeping a partial tail between chunks. */
export class LineSplitter {
  private tail = "";
  constructor(private readonly maxLine: number) {}
  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split("\n");
    this.tail = parts.pop() ?? "";
    if (this.tail.length > this.maxLine || parts.some((p) => p.length > this.maxLine))
      throw new Error("bridge_line_too_long");
    return parts.filter((p) => p !== "");
  }
}
