import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
}

/** Run `fn` whenever `deps` change; keeps the last data while reloading so lists do not flash. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    setError(undefined);
    fn().then(
      (d) => {
        if (id !== seq.current) return;
        setData(d);
        setLoading(false);
      },
      (e) => {
        if (id !== seq.current) return;
        setError(e);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}
