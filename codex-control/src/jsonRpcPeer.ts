import {
  CodexAppServerError,
  CodexControlError,
  type AppServerTransport,
  type JsonRpcId,
  type JsonRpcMessage,
} from "./types.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type ServerRequestHandler = (message: JsonRpcMessage) => Promise<unknown>;
export type NotificationHandler = (message: JsonRpcMessage) => void;

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private notificationHandler: NotificationHandler | null = null;
  private closed = false;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly requestTimeoutMs = 60_000,
  ) {}

  async start(): Promise<void> {
    this.transport.onMessage((message) => {
      void this.handleMessage(message);
    });
    this.transport.onClose((error) => {
      this.closed = true;
      this.failPending(error ?? new CodexControlError("Codex App Server transport closed."));
    });
    await this.transport.start();
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    if (this.closed) {
      throw new CodexControlError("Cannot send request after transport closed.");
    }

    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexControlError(`Timed out waiting for App Server response to ${method}.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    this.transport.send({ id, method, params: params ?? {} });
    return promise;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) {
      throw new CodexControlError("Cannot send notification after transport closed.");
    }
    this.transport.send({ method, params: params ?? {} });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failPending(new CodexControlError("Codex control client closed."));
    await this.transport.close();
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
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

  private handleResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id as JsonRpcId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id as JsonRpcId);

    if (message.error !== undefined) {
      pending.reject(new CodexAppServerError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    if (id === undefined) {
      return;
    }

    try {
      const result = this.serverRequestHandler
        ? await this.serverRequestHandler(message)
        : {};
      this.transport.send({ id, result });
    } catch (error) {
      this.transport.send({
        id,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
