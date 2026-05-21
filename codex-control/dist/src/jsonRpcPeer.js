import { CodexControlError, } from "./types.js";
export class JsonRpcPeer {
    transport;
    requestTimeoutMs;
    nextId = 1;
    pending = new Map();
    serverRequestHandler = null;
    notificationHandler = null;
    closed = false;
    constructor(transport, requestTimeoutMs = 60_000) {
        this.transport = transport;
        this.requestTimeoutMs = requestTimeoutMs;
    }
    async start() {
        this.transport.onMessage((message) => {
            void this.handleMessage(message);
        });
        this.transport.onClose((error) => {
            this.closed = true;
            this.failPending(error ?? new CodexControlError("Codex App Server transport closed."));
        });
        await this.transport.start();
    }
    onServerRequest(handler) {
        this.serverRequestHandler = handler;
    }
    onNotification(handler) {
        this.notificationHandler = handler;
    }
    async request(method, params, timeoutMs = this.requestTimeoutMs) {
        if (this.closed) {
            throw new CodexControlError("Cannot send request after transport closed.");
        }
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CodexControlError(`Timed out waiting for App Server response to ${method}.`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer,
            });
        });
        this.transport.send({ id, method, params: params ?? {} });
        return promise;
    }
    notify(method, params) {
        if (this.closed) {
            throw new CodexControlError("Cannot send notification after transport closed.");
        }
        this.transport.send({ method, params: params ?? {} });
    }
    async close() {
        this.closed = true;
        this.failPending(new CodexControlError("Codex control client closed."));
        await this.transport.close();
    }
    async handleMessage(message) {
        if (message.id !== undefined && message.method) {
            await this.handleServerRequest(message);
            return;
        }
        if (message.id !== undefined) {
            this.handleResponse(message);
            return;
        }
        if (message.method) {
            this.notificationHandler?.(message);
        }
    }
    handleResponse(message) {
        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error !== undefined) {
            pending.reject(new CodexControlError(JSON.stringify(message.error)));
            return;
        }
        pending.resolve(message.result);
    }
    async handleServerRequest(message) {
        const id = message.id;
        if (id === undefined) {
            return;
        }
        try {
            const result = this.serverRequestHandler
                ? await this.serverRequestHandler(message)
                : {};
            this.transport.send({ id, result });
        }
        catch (error) {
            this.transport.send({
                id,
                error: {
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
    failPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=jsonRpcPeer.js.map