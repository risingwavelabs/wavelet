import { useState, useEffect, useRef } from 'https://esm.sh/react@18';
import { WaveletClient } from './client.js';
import { WaveletError } from './types.js';

let globalClient = null;

export function initWavelet(options) {
  globalClient = new WaveletClient(options);
}

export function getClient() {
  if (!globalClient) {
    throw new WaveletError(
      'Wavelet client not initialized. Call initWavelet({ url: "..." }) first.',
      'CONNECTION_ERROR'
    );
  }
  return globalClient;
}

export function useWavelet(viewName, options) {
  const [data, setData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const dataRef = useRef([]);
  const keyBy = options?.keyBy;
  const params = options?.params;

  useEffect(() => {
    const client = getClient();
    let cancelled = false;

    client.view(viewName).get(params).then((rows) => {
      if (cancelled) return;
      dataRef.current = rows;
      setData(rows);
      setIsLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setError(err instanceof WaveletError ? err : new WaveletError(err.message, 'SERVER_ERROR'));
      setIsLoading(false);
    });

    const unsub = client.view(viewName).subscribe({
      onData: (diff) => {
        if (cancelled) return;

        if (keyBy) {
          dataRef.current = mergeByKey(dataRef.current, diff, keyBy);
        } else {
          dataRef.current = mergeNaive(dataRef.current, diff);
        }

        setData([...dataRef.current]);
      },
      onError: (err) => {
        if (cancelled) return;
        setError(err);
      },
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [viewName, keyBy, JSON.stringify(params)]);

  return { data, isLoading, error };
}

function mergeByKey(current, diff, keyBy) {
  const map = new Map();
  for (const row of current) {
    map.set(row[keyBy], row);
  }

  for (const row of diff.deleted) {
    map.delete(row[keyBy]);
  }

  for (const row of diff.updated) {
    map.set(row[keyBy], row);
  }

  for (const row of diff.inserted) {
    map.set(row[keyBy], row);
  }

  return Array.from(map.values());
}

function mergeNaive(current, diff) {
  let result = [...current];

  if (diff.deleted.length > 0) {
    const deletedJson = new Set(diff.deleted.map((row) => JSON.stringify(row)));
    result = result.filter((row) => !deletedJson.has(JSON.stringify(row)));
  }

  result.push(...diff.inserted);
  result.push(...diff.updated);

  return result;
}
