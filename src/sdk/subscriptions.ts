/**
 * Aizu Subscriptions - WebSocket-based reactive queries
 *
 * Provides Convex-style useQuery functionality where queries automatically
 * update when mutations affect the underlying data.
 */

import {
  AizuConfig,
  Subscription,
  SubscriptionOptions,
  ResultMessage,
  UpdateMessage,
  ErrorMessage,
  AizuError,
} from "./types";

type MessageHandler = (event: string, payload: unknown) => void;

/**
 * Phoenix Channel-compatible WebSocket client
 */
class PhoenixSocket {
  private ws: WebSocket | null = null;
  private channels: Map<string, PhoenixChannel> = new Map();
  private messageRef = 0;
  private pendingReplies: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }> = new Map();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private url: string;
  private project?: string;
  private tokenGetter?: AizuConfig["token"];
  private connected = false;
  private onConnect?: () => void;

  constructor(url: string, project?: string, token?: AizuConfig["token"]) {
    this.url = url;
    this.project = project;
    this.tokenGetter = token;
  }

  connect(onConnect?: () => void): void {
    this.onConnect = onConnect;
    this.doConnect();
  }

  private async resolveToken(): Promise<string | null> {
    if (!this.tokenGetter) return null;
    if (typeof this.tokenGetter === "string") return this.tokenGetter;
    const result = this.tokenGetter();
    return result instanceof Promise ? await result : result;
  }

  private async doConnect(): Promise<void> {
    let wsUrl = this.url.replace(/^http/, "ws") + "/ws/websocket?vsn=2.0.0";
    if (this.project) {
      wsUrl += `&project=${encodeURIComponent(this.project)}`;
    }
    const token = await this.resolveToken();
    if (token) {
      wsUrl += `&token=${encodeURIComponent(token)}`;
    }
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.connected = true;
      this.startHeartbeat();
      this.onConnect?.();

      // Rejoin all channels
      this.channels.forEach((channel) => channel.rejoin());
    };

    this.ws.onmessage = (event) => {
      this.handleMessage(JSON.parse(event.data));
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // Error handling done in onclose
    };
  }

  private handleMessage(msg: [string | null, string | null, string, string, unknown]): void {
    const [_joinRef, msgRef, topic, event, payload] = msg;

    // Handle reply
    if (msgRef && this.pendingReplies.has(msgRef)) {
      const { resolve, reject } = this.pendingReplies.get(msgRef)!;
      this.pendingReplies.delete(msgRef);

      if (event === "phx_reply") {
        const response = payload as { status: string; response: unknown };
        if (response.status === "ok") {
          resolve(response.response);
        } else {
          reject(new Error(JSON.stringify(response.response)));
        }
      }
      return;
    }

    // Route to channel
    const channel = this.channels.get(topic);
    if (channel) {
      channel.handleMessage(event, payload);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.push("phoenix", "heartbeat", {});
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.doConnect();
    }, 1000);
  }

  channel(topic: string): PhoenixChannel {
    let channel = this.channels.get(topic);
    if (!channel) {
      channel = new PhoenixChannel(this, topic);
      this.channels.set(topic, channel);
    }
    return channel;
  }

  push(topic: string, event: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) {
        reject(new Error("Not connected"));
        return;
      }

      const ref = String(++this.messageRef);
      this.pendingReplies.set(ref, { resolve, reject });

      const msg = [null, ref, topic, event, payload];
      this.ws.send(JSON.stringify(msg));

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingReplies.has(ref)) {
          this.pendingReplies.delete(ref);
          reject(new Error("Request timed out"));
        }
      }, 5000);
    });
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

class PhoenixChannel {
  private socket: PhoenixSocket;
  private topic: string;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private joined = false;
  private joinPayload: Record<string, unknown> = {};
  private rejoinCallback?: () => void;

  constructor(socket: PhoenixSocket, topic: string) {
    this.socket = socket;
    this.topic = topic;
  }

  join(payload: Record<string, unknown> = {}): Promise<unknown> {
    this.joinPayload = payload;
    return this.doJoin(false);
  }

  private async doJoin(isRejoin: boolean = false): Promise<unknown> {
    const result = await this.socket.push(this.topic, "phx_join", this.joinPayload);
    this.joined = true;
    if (isRejoin && this.rejoinCallback) {
      this.rejoinCallback();
    }
    return result;
  }

  rejoin(): void {
    if (this.joined) {
      this.doJoin(true).catch(() => {
        // Rejoin failed, will retry on next reconnect
      });
    }
  }

  onRejoin(callback: () => void): void {
    this.rejoinCallback = callback;
  }

  push(event: string, payload: unknown): Promise<unknown> {
    return this.socket.push(this.topic, event, payload);
  }

  on(event: string, handler: MessageHandler): () => void {
    const handlers = this.handlers.get(event) || [];
    handlers.push(handler);
    this.handlers.set(event, handlers);

    return () => {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) {
        handlers.splice(idx, 1);
      }
    };
  }

  handleMessage(event: string, payload: unknown): void {
    const handlers = this.handlers.get(event) || [];
    handlers.forEach((handler) => handler(event, payload));
  }

  leave(): void {
    this.joined = false;
    this.socket.push(this.topic, "phx_leave", {}).catch(() => {
      // Ignore leave errors
    });
  }
}

/**
 * Subscription client for reactive queries
 */
export class SubscriptionClient {
  private socket: PhoenixSocket;
  private channel: PhoenixChannel | null = null;
  private subscriptions: Map<string, {
    functionName: string;
    args: Record<string, unknown>;
    callback: (data: unknown, version: number) => void;
    errorCallback?: (error: Error) => void;
  }> = new Map();
  private subCounter = 0;
  private connected = false;
  private debug: boolean;
  private connectPromise: Promise<void> | null = null;

  constructor(config: AizuConfig) {
    this.debug = config.debug ?? false;
    this.socket = new PhoenixSocket(config.url, config.project, config.token);
  }

  /**
   * Connect to the subscription server
   */
  connect(): Promise<void> {
    // Return existing promise if already connecting
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve) => {
      this.socket.connect(() => {
        this.setupChannel().then(resolve);
      });
    });

    return this.connectPromise;
  }

  private async setupChannel(): Promise<void> {
    this.channel = this.socket.channel("subscriptions");

    // Set up event handlers before joining
    this.channel.on("result", (_, payload) => {
      const msg = payload as ResultMessage;
      this.handleResult(msg);
    });

    this.channel.on("update", (_, payload) => {
      const msg = payload as UpdateMessage;
      this.handleUpdate(msg);
    });

    this.channel.on("error", (_, payload) => {
      const msg = payload as ErrorMessage;
      this.handleError(msg);
    });

    // Handle channel rejoin (after reconnect)
    this.channel.onRejoin(() => {
      this.log("Channel rejoined, re-subscribing to all queries");
      this.resubscribeAll();
    });

    await this.channel.join();
    this.connected = true;
    this.log("Connected to subscription channel");
  }

  private async resubscribeAll(): Promise<void> {
    // Re-subscribe all active subscriptions in parallel
    const promises = Array.from(this.subscriptions).map(([clientSubId, sub]) => {
      this.log("Re-subscribing to", sub.functionName);
      return this.channel!.push("subscribe", {
        id: clientSubId,
        function: sub.functionName,
        args: sub.args,
      }).catch((error) => {
        this.log("Failed to re-subscribe:", error);
        sub.errorCallback?.(error instanceof Error ? error : new Error(String(error)));
      });
    });

    await Promise.all(promises);
  }

  /**
   * Disconnect from the subscription server
   */
  disconnect(): void {
    this.channel?.leave();
    this.socket.disconnect();
    this.connected = false;
    this.connectPromise = null;
    this.subscriptions.clear();
  }

  /**
   * Subscribe to a query function
   */
  async subscribe<T = unknown>(
    functionName: string,
    options?: SubscriptionOptions
  ): Promise<Subscription> {
    if (!this.connected) {
      await this.connect();
    }

    const clientSubId = `sub_${++this.subCounter}`;
    const args = options?.args ?? {};

    this.log("Subscribing to", functionName, args);

    // Store subscription with function info for reconnection
    this.subscriptions.set(clientSubId, {
      functionName,
      args,
      callback: (data, version) => options?.onUpdate?.(data as T, version),
      errorCallback: options?.onError,
    });

    // Send subscribe message
    await this.channel!.push("subscribe", {
      id: clientSubId,
      function: functionName,
      args,
    });

    return {
      id: clientSubId,
      version: 0,
      unsubscribe: () => this.unsubscribe(clientSubId),
    };
  }

  /**
   * Unsubscribe from a query
   */
  unsubscribe(subscriptionId: string): void {
    const sub = this.subscriptions.get(subscriptionId);
    if (!sub) return;

    this.subscriptions.delete(subscriptionId);

    this.channel?.push("unsubscribe", { id: subscriptionId }).catch(() => {
      // Ignore unsubscribe errors
    });

    this.log("Unsubscribed from", subscriptionId);
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  private handleResult(msg: ResultMessage): void {
    const sub = this.subscriptions.get(msg.id);
    if (sub) {
      this.log("Received result for", msg.id, "version", msg.version);
      sub.callback(msg.data, msg.version);
    }
  }

  private handleUpdate(msg: UpdateMessage): void {
    const sub = this.subscriptions.get(msg.id);
    if (sub) {
      this.log("Received update for", msg.id, "version", msg.version);
      sub.callback(msg.data, msg.version);
    }
  }

  private handleError(msg: ErrorMessage): void {
    const sub = this.subscriptions.get(msg.id);
    if (sub?.errorCallback) {
      sub.errorCallback(new AizuError(msg.message, msg.code));
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[Aizu Subscriptions]", ...args);
    }
  }
}
