// Human vs JSON output. In --json mode nothing but ONE JSON document reaches stdout:
// human lines are suppressed and warnings are collected into the document instead.

export interface Writable {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface Io {
  stdout: Writable;
  stderr: Writable;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd: string;
}

export function colorEnabled(stream: Writable): boolean {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR;
}

const CODES = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] } as const;
export type Color = keyof typeof CODES;

export class Output {
  readonly warnings: string[] = [];
  constructor(
    public io: Io,
    public json: boolean,
  ) {}

  get color(): boolean {
    return !this.json && colorEnabled(this.io.stdout);
  }

  c(color: Color, text: string): string {
    if (!this.color) return text;
    const [a, b] = CODES[color];
    return `\u001b[${a}m${text}\u001b[${b}m`;
  }

  /** A human line on stdout; suppressed in --json mode. */
  line(text = ""): void {
    if (!this.json) this.io.stdout.write(text + "\n");
  }

  /** A warning: stderr for humans, collected into the JSON document otherwise. */
  warn(text: string): void {
    this.warnings.push(text);
    if (!this.json) {
      const prefix = colorEnabled(this.io.stderr) ? "\u001b[33mwarning\u001b[39m" : "warning";
      this.io.stderr.write(`${prefix}: ${text}\n`);
    }
  }

  /** The single JSON document for --json mode (no-op otherwise). */
  result(data: Record<string, unknown>): void {
    if (!this.json) return;
    const doc: Record<string, unknown> = { ok: true, ...data };
    if (this.warnings.length) doc.warnings = this.warnings;
    this.io.stdout.write(JSON.stringify(doc, null, 2) + "\n");
  }

  table(headers: string[], rows: string[][], opts: { maxWidth?: number; flex?: number } = {}): void {
    if (this.json) return;
    this.line(renderTable(headers, rows, { ...opts, color: this.color }));
  }

  get width(): number {
    return this.io.stdout.columns && this.io.stdout.columns > 40 ? this.io.stdout.columns : 120;
  }
}

/** Cut on a word boundary and append an ellipsis; never a bare slice. */
export function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  if (max <= 1) return "…".slice(0, max);
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const base = space > max * 0.5 ? cut.slice(0, space) : cut;
  return base.replace(/[\s,.;:-]+$/, "") + "…";
}

/** Render rows as aligned columns. `flex` names the column that shrinks to fit maxWidth. */
export function renderTable(
  headers: string[],
  rows: string[][],
  opts: { maxWidth?: number; flex?: number; color?: boolean } = {},
): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const gap = 2;
  if (opts.maxWidth !== undefined && opts.flex !== undefined) {
    const others = widths.reduce((n, w, i) => (i === opts.flex ? n : n + w + gap), 0);
    const room = Math.max(20, opts.maxWidth - others);
    if ((widths[opts.flex] ?? 0) > room) {
      widths[opts.flex] = room;
      rows = rows.map((r) => r.map((cell, i) => (i === opts.flex ? truncate(cell, room) : cell)));
    }
  }
  const fmt = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join(" ".repeat(gap))
      .trimEnd();
  const head = fmt(headers);
  const lines = [opts.color ? `\u001b[1m${head}\u001b[22m` : head, ...rows.map(fmt)];
  return lines.join("\n");
}
