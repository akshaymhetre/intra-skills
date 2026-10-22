// The catalog's query field. Qualifiers (`stack:terraform`) are highlighted in place: the real input
// sits on top with transparent text, and a mirror behind it draws the same characters in the same
// mono face and size (so the caret lines up), with each `key:value` drawn as a quiet token.
// Phones show the plain text: the mirror cannot follow a 16px input that scrolls with the keyboard.
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { normalizeQuery, tokenizeForDisplay } from "../../lib/query";
import { cx } from "../../lib/cx";
import { Kbd } from "../ui";

export function useNarrow(query = "(max-width: 767px)") {
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, [query]);
  return on;
}

export function QueryField({
  value,
  onCommit,
  className,
}: {
  value: string;
  /** Called with the canonical query; `replace` is true while typing so history keeps one entry. */
  onCommit: (q: string, replace?: boolean) => void;
  className?: string;
}) {
  const [text, setText] = useState(value);
  const committed = useRef(value);
  const timer = useRef<number | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  // Follow the URL when it changes from elsewhere (a facet click, back and forward, the palette).
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const sync = () => {
    if (mirror.current && input.current) mirror.current.scrollLeft = input.current.scrollLeft;
  };
  useEffect(sync, [text]);

  const commit = (t: string, replace: boolean) => {
    const canonical = t.trim() ? normalizeQuery(t) : "";
    committed.current = canonical;
    onCommit(canonical, replace);
  };

  const runs = tokenizeForDisplay(text);

  return (
    <form
      role="search"
      className={cx("relative", className)}
      onSubmit={(e) => {
        e.preventDefault();
        window.clearTimeout(timer.current);
        const canonical = text.trim() ? normalizeQuery(text) : "";
        setText(canonical);
        commit(canonical, false);
      }}
    >
      <label htmlFor="catalog-query" className="sr-only">
        Search skills. Qualifiers: team, stack, area, tool, tag, is:private, is:verified, is:stale, is:deprecated, sort.
      </label>
      <div className="relative flex h-12 items-center rounded-lg border border-line-strong bg-surface transition-colors duration-[120ms] hover:border-line-control focus-within:border-sel">
        <Search className="pointer-events-none absolute left-4 size-4 text-fg-subtle" aria-hidden />
        <div
          ref={mirror}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-16 left-11 flex items-center overflow-hidden font-mono text-sm whitespace-pre max-md:hidden"
        >
          <span className="text-fg">
            {runs.map((r, i) =>
              r.kind === "key" || r.kind === "neg" ? (
                <span key={i} className="rounded-l-[3px] bg-surface-3 text-fg-subtle shadow-[-3px_0_0_var(--tint)]">
                  {r.text}
                </span>
              ) : r.kind === "value" ? (
                <span key={i} className="rounded-r-[3px] bg-surface-3 text-fg shadow-[3px_0_0_var(--tint)]">
                  {r.text}
                </span>
              ) : (
                <span key={i}>{r.text}</span>
              ),
            )}
          </span>
        </div>
        <input
          ref={input}
          id="catalog-query"
          data-query-input
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={text}
          placeholder={narrow ? "Search skills" : "Search skills, or try stack:terraform is:verified"}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => commit(v, true), 300);
          }}
          onScroll={sync}
          onSelect={sync}
          onKeyUp={sync}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            if (text) {
              e.preventDefault();
              window.clearTimeout(timer.current);
              setText("");
              commit("", true);
            } else (e.target as HTMLInputElement).blur();
          }}
          className="relative h-full w-full min-w-0 bg-transparent pr-16 pl-11 font-mono text-sm text-transparent caret-sel outline-none placeholder:text-fg-subtle focus-visible:outline-none max-md:text-[16px] max-md:text-fg"
        />
        <div className="absolute right-2 flex items-center gap-1">
          {text ? (
            <button
              type="button"
              aria-label="Clear the search"
              title="Clear the search (Esc)"
              onClick={() => {
                window.clearTimeout(timer.current);
                setText("");
                commit("", false);
                input.current?.focus();
              }}
              className="inline-flex size-8 items-center justify-center rounded-md text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg max-md:size-11"
            >
              <X className="size-4" aria-hidden />
            </button>
          ) : (
            <Kbd className="mr-1.5 font-mono max-md:hidden">/</Kbd>
          )}
        </div>
      </div>
    </form>
  );
}
