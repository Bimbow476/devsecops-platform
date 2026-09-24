import { useCallback, useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  retries: number;
}

/**
 * Періодичне опитування API з експоненційним backoff при збоях —
 * демонструє стійку клієнт-серверну взаємодію (graceful degradation).
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retries, setRetries] = useState(0);

  const failRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const aliveRef = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (!aliveRef.current) return;
      setData(result);
      setError(null);
      setLoading(false);
      failRef.current = 0;
      setRetries(0);
      timerRef.current = window.setTimeout(() => void run(), intervalMs);
    } catch (err) {
      if (!aliveRef.current) return;
      setLoading(false);
      failRef.current += 1;
      setRetries(failRef.current);
      setError(err instanceof Error ? err.message : String(err));
      const backoff = intervalMs * Math.min(Math.pow(2, failRef.current), 8);
      timerRef.current = window.setTimeout(() => void run(), backoff);
    }
  }, [intervalMs]);

  useEffect(() => {
    aliveRef.current = true;
    void run();
    return () => {
      aliveRef.current = false;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, [run]);

  return { data, error, loading, retries };
}