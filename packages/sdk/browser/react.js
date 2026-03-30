import { useState, useEffect, useRef, useCallback } from 'react';
import { WaveletClient } from './client.js';
import { WaveletError } from './types.js';
let globalClient = null;
export function initWavelet(options) {
    globalClient = new WaveletClient(options);
}
export function getClient() {
    if (!globalClient) {
        throw new WaveletError('Wavelet client not initialized. Call initWavelet({ url: "..." }) first.', 'CONNECTION_ERROR');
    }
    return globalClient;
}
export function useWavelet(queryName, options) {
    const [data, setData] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const dataRef = useRef([]);
    const keyBy = options?.keyBy;
    const params = options?.params;
    useEffect(() => {
        const client = getClient();
        let cancelled = false;
        // Initial fetch
        client.query(queryName).get(params).then((rows) => {
            if (cancelled)
                return;
            dataRef.current = rows;
            setData(rows);
            setIsLoading(false);
        }).catch((err) => {
            if (cancelled)
                return;
            setError(err instanceof WaveletError ? err : new WaveletError(err.message, 'SERVER_ERROR'));
            setIsLoading(false);
        });
        // Subscribe to updates
        const unsub = client.query(queryName).subscribe({
            onData: (diff) => {
                if (cancelled)
                    return;
                if (keyBy) {
                    dataRef.current = mergeByKey(dataRef.current, diff, keyBy);
                }
                else {
                    dataRef.current = mergeNaive(dataRef.current, diff);
                }
                setData([...dataRef.current]);
            },
            onError: (err) => {
                if (cancelled)
                    return;
                setError(err);
            },
        });
        return () => {
            cancelled = true;
            unsub();
        };
    }, [queryName, keyBy, JSON.stringify(params)]);
    return { data, isLoading, error };
}
/**
 * Like useWavelet, but tracks which rows changed in the last diff cycle.
 * `changes` is a Map from keyBy value to change type, cleared after `changeDuration` ms.
 * `keyBy` is required.
 */
export function useWaveletDiff(queryName, options) {
    const { keyBy, params, changeDuration = 500 } = options;
    const [data, setData] = useState([]);
    const [changes, setChanges] = useState(new Map());
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const dataRef = useRef([]);
    const clearTimerRef = useRef(undefined);
    const applyDiff = useCallback((diff) => {
        const newChanges = new Map();
        dataRef.current = mergeByKey(dataRef.current, diff, keyBy);
        for (const row of diff.inserted) {
            newChanges.set(row[keyBy], 'inserted');
        }
        for (const row of diff.updated) {
            newChanges.set(row[keyBy], 'updated');
        }
        for (const row of diff.deleted) {
            newChanges.set(row[keyBy], 'deleted');
        }
        setData([...dataRef.current]);
        setChanges(newChanges);
        if (clearTimerRef.current)
            clearTimeout(clearTimerRef.current);
        clearTimerRef.current = setTimeout(() => setChanges(new Map()), changeDuration);
    }, [keyBy, changeDuration]);
    useEffect(() => {
        const client = getClient();
        let cancelled = false;
        client.query(queryName).get(params).then((rows) => {
            if (cancelled)
                return;
            dataRef.current = rows;
            setData(rows);
            setIsLoading(false);
        }).catch((err) => {
            if (cancelled)
                return;
            setError(err instanceof WaveletError ? err : new WaveletError(err.message, 'SERVER_ERROR'));
            setIsLoading(false);
        });
        const unsub = client.query(queryName).subscribe({
            onData: (diff) => {
                if (cancelled)
                    return;
                applyDiff(diff);
            },
            onError: (err) => {
                if (cancelled)
                    return;
                setError(err);
            },
        });
        return () => {
            cancelled = true;
            unsub();
            if (clearTimerRef.current)
                clearTimeout(clearTimerRef.current);
        };
    }, [queryName, keyBy, JSON.stringify(params), applyDiff]);
    return { data, changes, isLoading, error };
}
/**
 * Key-based merge: uses a specified field as primary key.
 * O(n) using a Map, no JSON.stringify needed.
 */
function mergeByKey(current, diff, keyBy) {
    const map = new Map();
    for (const row of current) {
        map.set(row[keyBy], row);
    }
    // Remove deleted rows
    for (const row of diff.deleted) {
        map.delete(row[keyBy]);
    }
    // Apply updates (replace existing rows by key)
    for (const row of diff.updated) {
        map.set(row[keyBy], row);
    }
    // Add inserted rows
    for (const row of diff.inserted) {
        map.set(row[keyBy], row);
    }
    return Array.from(map.values());
}
/**
 * Naive merge: uses JSON.stringify for equality.
 * Fallback when no keyBy is specified.
 */
function mergeNaive(current, diff) {
    let result = [...current];
    if (diff.deleted.length > 0) {
        const deletedJson = new Set(diff.deleted.map(r => JSON.stringify(r)));
        result = result.filter(r => !deletedJson.has(JSON.stringify(r)));
    }
    result.push(...diff.inserted);
    result.push(...diff.updated);
    return result;
}
