import { WaveletError } from './types.js';
export class WaveletClient {
    options;
    baseUrl;
    wsBaseUrl;
    tokenProvider;
    constructor(options) {
        this.options = options;
        // Normalize URLs
        this.baseUrl = options.url.replace(/\/$/, '').replace(/^ws/, 'http');
        this.wsBaseUrl = options.url.replace(/\/$/, '').replace(/^http/, 'ws');
        if (typeof options.token === 'function') {
            const fn = options.token;
            this.tokenProvider = async () => {
                const t = fn();
                return t instanceof Promise ? t : t;
            };
        }
        else if (typeof options.token === 'string') {
            const t = options.token;
            this.tokenProvider = async () => t;
        }
        else {
            this.tokenProvider = null;
        }
    }
    query(name) {
        return {
            get: (params) => this.getQuery(name, params),
            subscribe: (handlers) => this.subscribeQuery(name, handlers),
        };
    }
    /** @deprecated Use query() instead */
    view(name) {
        return this.query(name);
    }
    event(name) {
        return {
            emit: (data) => this.emitEvent(name, data),
            emitBatch: (data) => this.emitBatch(name, data),
        };
    }
    /** @deprecated Use event() instead */
    stream(name) {
        return this.event(name);
    }
    async getQuery(name, params) {
        const url = new URL(`${this.baseUrl}/v1/queries/${name}`);
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                url.searchParams.set(k, v);
            }
        }
        const headers = { 'Content-Type': 'application/json' };
        if (this.tokenProvider) {
            headers['Authorization'] = `Bearer ${await this.tokenProvider()}`;
        }
        const res = await fetch(url.toString(), { headers });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            if (res.status === 404)
                throw new WaveletError(body.error ?? `Query '${name}' not found`, 'QUERY_NOT_FOUND');
            if (res.status === 401)
                throw new WaveletError(body.error ?? 'Authentication required', 'AUTH_ERROR');
            throw new WaveletError(body.error ?? `Server error: ${res.status}`, 'SERVER_ERROR');
        }
        const data = await res.json();
        return data.rows;
    }
    subscribeQuery(name, handlers) {
        let ws = null;
        let closed = false;
        let reconnectAttempt = 0;
        const maxReconnectDelay = 30000;
        let lastCursor = null;
        const connect = async () => {
            if (closed)
                return;
            let url = `${this.wsBaseUrl}/subscribe/${name}`;
            if (this.tokenProvider) {
                const token = await this.tokenProvider();
                url += `?token=${encodeURIComponent(token)}`;
            }
            if (lastCursor) {
                url += `${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(lastCursor)}`;
            }
            ws = new WebSocket(url);
            ws.onopen = () => {
                reconnectAttempt = 0;
                handlers.onOpen?.();
            };
            ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
                    if (msg.type === 'snapshot') {
                        handlers.onSnapshot?.({
                            rows: msg.rows ?? [],
                        });
                    }
                    else if (msg.type === 'diff') {
                        lastCursor = msg.cursor;
                        handlers.onData({
                            cursor: msg.cursor,
                            inserted: msg.inserted ?? [],
                            updated: msg.updated ?? [],
                            deleted: msg.deleted ?? [],
                        });
                    }
                }
                catch (err) {
                    handlers.onError?.(new WaveletError(err.message, 'SERVER_ERROR'));
                }
            };
            ws.onerror = () => {
                // onclose will fire next
            };
            ws.onclose = (event) => {
                if (closed)
                    return;
                if (event.code === 4000) {
                    // Server rejected connection (auth error, view not found)
                    handlers.onError?.(new WaveletError(event.reason, 'AUTH_ERROR'));
                    return;
                }
                // Reconnect with exponential backoff
                const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), maxReconnectDelay);
                reconnectAttempt++;
                setTimeout(() => {
                    handlers.onReconnect?.();
                    connect();
                }, delay);
            };
        };
        connect();
        return () => {
            closed = true;
            ws?.close();
        };
    }
    async emitEvent(eventName, data) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.tokenProvider) {
            headers['Authorization'] = `Bearer ${await this.tokenProvider()}`;
        }
        const res = await fetch(`${this.baseUrl}/v1/events/${eventName}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(data),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new WaveletError(body.error ?? `Failed to emit to '${eventName}'`, 'SERVER_ERROR');
        }
    }
    async emitBatch(eventName, data) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.tokenProvider) {
            headers['Authorization'] = `Bearer ${await this.tokenProvider()}`;
        }
        const res = await fetch(`${this.baseUrl}/v1/events/${eventName}/batch`, {
            method: 'POST',
            headers,
            body: JSON.stringify(data),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new WaveletError(body.error ?? `Failed to batch emit to '${eventName}'`, 'SERVER_ERROR');
        }
    }
}
