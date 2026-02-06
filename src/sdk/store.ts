/**
 * Aizu Query Store - Modern React-compatible external store
 *
 * Uses a pub/sub pattern compatible with useSyncExternalStore.
 * Provides caching, deduplication, and automatic refetching.
 */

import { AizuClient } from "./client";
import { SubscriptionClient } from "./subscriptions";
import type { AizuConfig } from "./types";

export type QueryStatus = "pending" | "success" | "error";

export interface QueryState<T = unknown> {
  status: QueryStatus;
  data: T | undefined;
  error: Error | undefined;
  /** Data version from subscription updates */
  version: number;
  /** Timestamp of last successful fetch */
  fetchedAt: number;
}

interface QueryEntry<T = unknown> {
  state: QueryState<T>;
  listeners: Set<() => void>;
  functionName: string;
  args?: Record<string, unknown>;
  unsubscribe?: () => void;
  subscribing?: boolean;
}

export class QueryStore {
  private client: AizuClient;
  private subscriptions: SubscriptionClient;
  private queries: Map<string, QueryEntry> = new Map();
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private connectionListeners: Set<() => void> = new Set();
  private debug: boolean;

  constructor(config: AizuConfig) {
    this.debug = config.debug ?? false;
    this.client = new AizuClient(config);
    this.subscriptions = new SubscriptionClient(config);
    // Start WS connection immediately — don't wait for useEffect (saves ~16ms)
    this.connect();
  }

  /**
   * Connect to the subscription server
   */
  connect(): Promise<void> {
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.subscriptions.connect().then(() => {
      this.connected = true;
      this.notifyConnectionListeners();
      // Re-subscribe all active queries
      this.resubscribeAll();
    });

    return this.connectPromise;
  }

  /**
   * Disconnect from the subscription server
   */
  disconnect(): void {
    this.subscriptions.disconnect();
    this.connected = false;
    this.connectPromise = null;
    // Preserve entries across reconnections (handles React StrictMode
    // unmount/remount). Clear subscription handles so resubscribeAll
    // re-establishes them on next connect.
    for (const entry of this.queries.values()) {
      entry.unsubscribe = undefined;
      entry.subscribing = false;
    }
  }

  /**
   * Check if connected to subscription server
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Subscribe to connection state changes
   */
  subscribeToConnection(listener: () => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /**
   * Get connection snapshot for useSyncExternalStore
   */
  getConnectionSnapshot = (): boolean => {
    return this.connected;
  };

  private notifyConnectionListeners(): void {
    this.connectionListeners.forEach((listener) => listener());
  }

  /**
   * Get a unique key for a query
   */
  private getQueryKey(functionName: string, args?: Record<string, unknown>): string {
    return `${functionName}:${JSON.stringify(args ?? {})}`;
  }

  /**
   * Subscribe to a query's state changes (for useSyncExternalStore)
   */
  subscribe(
    functionName: string,
    args?: Record<string, unknown>
  ): (listener: () => void) => () => void {
    return (listener: () => void) => {
      const key = this.getQueryKey(functionName, args);
      const entry = this.getOrCreateEntry(key, functionName, args);
      entry.listeners.add(listener);

      return () => {
        entry.listeners.delete(listener);
        // Clean up if no more listeners
        if (entry.listeners.size === 0) {
          this.cleanupEntry(key);
        }
      };
    };
  }

  /**
   * Get current snapshot of a query's state (for useSyncExternalStore)
   */
  getSnapshot<T>(
    functionName: string,
    args?: Record<string, unknown>
  ): () => QueryState<T> {
    return () => {
      const key = this.getQueryKey(functionName, args);
      const entry = this.queries.get(key);

      if (!entry) {
        // Return initial pending state
        return {
          status: "pending",
          data: undefined,
          error: undefined,
          version: 0,
          fetchedAt: 0,
        };
      }

      return entry.state as QueryState<T>;
    };
  }

  /**
   * Imperatively fetch a query (for initial load or manual refresh)
   */
  async fetch<T>(
    functionName: string,
    args?: Record<string, unknown>
  ): Promise<T> {
    const key = this.getQueryKey(functionName, args);
    const entry = this.getOrCreateEntry<T>(key, functionName, args);

    try {
      const data = await this.client.query<T>(functionName, args);

      entry.state = {
        status: "success",
        data,
        error: undefined,
        version: entry.state.version,
        fetchedAt: Date.now(),
      };

      this.notifyListeners(entry);
      return data;
    } catch (error) {
      entry.state = {
        status: "error",
        data: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        version: entry.state.version,
        fetchedAt: entry.state.fetchedAt,
      };

      this.notifyListeners(entry);
      throw error;
    }
  }

  /**
   * Get the HTTP client for mutations
   */
  getClient(): AizuClient {
    return this.client;
  }

  private getOrCreateEntry<T>(
    key: string,
    functionName: string,
    args?: Record<string, unknown>
  ): QueryEntry<T> {
    let entry = this.queries.get(key) as QueryEntry<T> | undefined;

    if (!entry) {
      entry = {
        state: {
          status: "pending",
          data: undefined,
          error: undefined,
          version: 0,
          fetchedAt: 0,
        },
        listeners: new Set(),
        functionName,
        args,
      };

      this.queries.set(key, entry);

      // Subscribe via WebSocket - initial data comes via "result" event
      if (this.connected) {
        this.setupSubscription(key, functionName, args);
      }
    }

    return entry;
  }

  private async setupSubscription(
    key: string,
    functionName: string,
    args?: Record<string, unknown>
  ): Promise<void> {
    const entry = this.queries.get(key);
    if (!entry || entry.unsubscribe || entry.subscribing) return;

    entry.subscribing = true;

    try {
      const subscription = await this.subscriptions.subscribe(functionName, {
        args,
        onUpdate: (data, version) => {
          const currentEntry = this.queries.get(key);
          if (currentEntry) {
            currentEntry.state = {
              status: "success",
              data,
              error: undefined,
              version,
              fetchedAt: Date.now(),
            };
            this.notifyListeners(currentEntry);
          }
        },
        onError: (error) => {
          const currentEntry = this.queries.get(key);
          if (currentEntry) {
            currentEntry.state = {
              ...currentEntry.state,
              status: "error",
              error,
            };
            this.notifyListeners(currentEntry);
          }
        },
      });

      entry.unsubscribe = subscription.unsubscribe;
    } catch (error) {
      this.log("Failed to set up subscription:", error);
    } finally {
      entry.subscribing = false;
    }
  }

  private resubscribeAll(): void {
    for (const [key, entry] of this.queries) {
      if (!entry.unsubscribe && !entry.subscribing && entry.listeners.size > 0) {
        this.setupSubscription(key, entry.functionName, entry.args);
      }
    }
  }

  private cleanupEntry(key: string): void {
    // Delay cleanup to handle React StrictMode unmount/remount cycle.
    // Without this, StrictMode's unmount→remount creates duplicate subscriptions.
    setTimeout(() => {
      const entry = this.queries.get(key);
      if (entry && entry.listeners.size === 0) {
        entry.unsubscribe?.();
        this.queries.delete(key);
      }
    }, 100);
  }

  private notifyListeners(entry: QueryEntry): void {
    entry.listeners.forEach((listener) => listener());
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[Aizu Store]", ...args);
    }
  }
}
