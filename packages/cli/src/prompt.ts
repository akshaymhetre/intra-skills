import { createInterface } from "node:readline/promises";
import type { Ctx } from "./command.js";

/** True when a person can answer a question: both ends are terminals and --json is off. */
export function interactive(ctx: Ctx): boolean {
  return Boolean(ctx.io.stdin.isTTY) && Boolean(ctx.io.stdout.isTTY) && !ctx.out.json;
}

/** Ask a y/N question on stderr. Anything but y/yes is no. */
export async function confirm(ctx: Ctx, question: string): Promise<boolean> {
  const rl = createInterface({ input: ctx.io.stdin, output: ctx.io.stderr as NodeJS.WritableStream });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
