/** Join class names, skipping falsy parts. */
export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}
