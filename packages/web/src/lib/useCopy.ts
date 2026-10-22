import { useCallback, useEffect, useRef, useState } from "react";

/** Write text to the clipboard (with a textarea fallback for blocked clipboard APIs). */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

/** `copied` stays true for `timeout` ms after a copy. 1500 ms matches the install-line moment. */
export function useCopy(timeout = 1500) {
  const [copied, setCopied] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(t.current), []);
  const copy = useCallback(
    async (text: string) => {
      await copyText(text);
      setCopied(true);
      window.clearTimeout(t.current);
      t.current = window.setTimeout(() => setCopied(false), timeout);
    },
    [timeout],
  );
  return { copied, copy };
}
