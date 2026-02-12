/**
 * Aizu React Hooks - Modern React 18+ compatible hooks
 *
 * Zero useEffect — all subscriptions use useSyncExternalStore for
 * proper concurrent mode support and optimal performance.
 *
 * @example
 * ```tsx
 * import { AizuProvider, useQuery, useMutation } from "aizu/react";
 *
 * function App() {
 *   return (
 *     <AizuProvider url="https://myproject.aizu.sh">
 *       <TodoList />
 *     </AizuProvider>
 *   );
 * }
 *
 * function TodoList() {
 *   const todos = useQuery("list_todos", { user_id: "123" });
 *   const createTodo = useMutation("create_todo");
 *
 *   if (todos === undefined) return <div>Loading...</div>;
 *
 *   return (
 *     <div>
 *       {todos.map(todo => <Todo key={todo.id} todo={todo} />)}
 *       <button onClick={() => createTodo({ title: "New todo" })}>
 *         Add Todo
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { QueryStore, type QueryState } from "./store";
import { AizuClient } from "./client";
import { AizuAuth } from "./auth";
import type { AizuConfig, User, InvokeOptions } from "./types";
import { AizuStorage } from "./storage";

interface AizuContextValue {
  store: QueryStore;
  auth: AizuAuth;
}

const AizuContext = createContext<AizuContextValue | null>(null);

interface AizuProviderProps extends AizuConfig {
  children: ReactNode;
}

export function AizuProvider({ children, ...config }: AizuProviderProps) {
  // Create stable instances — only recreate if URL changes.
  // The store connects eagerly in its constructor (no useEffect needed).
  // WS closes naturally on page unload, and the store handles React
  // StrictMode's unmount/remount cycle internally.
  const instances = useMemo(() => {
    const auth = new AizuAuth(config);
    auth.loadFromStorage();

    const store = new QueryStore({
      ...config,
      token: () => auth.getAccessToken(),
    });

    return { store, auth };
  }, [config.url, config.project]);

  return (
    <AizuContext.Provider value={instances}>
      {children}
    </AizuContext.Provider>
  );
}

function useAizu(): AizuContextValue {
  const context = useContext(AizuContext);
  if (!context) {
    throw new Error("useAizu must be used within an AizuProvider");
  }
  return context;
}

/**
 * Get the Aizu client for direct API calls
 */
export function useAizuClient(): AizuClient {
  return useAizu().store.getClient();
}

/**
 * Get the Aizu auth instance
 */
export function useAizuAuth(): AizuAuth {
  return useAizu().auth;
}

/**
 * Check if connected to subscription server
 */
export function useIsConnected(): boolean {
  const { store } = useAizu();

  return useSyncExternalStore(
    store.subscribeToConnection.bind(store),
    store.getConnectionSnapshot,
    store.getConnectionSnapshot
  );
}

interface UseQueryOptions {
  /**
   * Skip the query (useful for conditional queries)
   */
  skip?: boolean;
}

/**
 * Subscribe to a query function with automatic updates
 *
 * Returns `undefined` while loading, then the query result.
 * Automatically updates when mutations affect the data.
 *
 * Uses useSyncExternalStore for React 18 concurrent mode compatibility.
 *
 * @example
 * ```tsx
 * const todos = useQuery("list_todos", { user_id: "123" });
 *
 * if (todos === undefined) return <Loading />;
 * return <TodoList todos={todos} />;
 * ```
 */
export function useQuery<T = unknown>(
  functionName: string,
  args?: Record<string, unknown>,
  options?: UseQueryOptions
): T | undefined {
  const { store } = useAizu();
  const argsKey = JSON.stringify(args ?? {});

  const subscribe = useMemo(
    () => (options?.skip ? () => () => {} : store.subscribe(functionName, args)),
    [store, functionName, argsKey, options?.skip]
  );

  const getSnapshot = useMemo(
    () => (options?.skip
      ? () => ({ status: "pending", data: undefined, error: undefined, version: 0, fetchedAt: 0 } as QueryState<T>)
      : store.getSnapshot<T>(functionName, args)),
    [store, functionName, argsKey, options?.skip]
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return state.data;
}

/**
 * Like useQuery but returns full state object
 */
export function useQueryWithStatus<T = unknown>(
  functionName: string,
  args?: Record<string, unknown>,
  options?: UseQueryOptions
): QueryState<T> {
  const { store } = useAizu();
  const argsKey = JSON.stringify(args ?? {});

  const subscribe = useMemo(
    () => (options?.skip ? () => () => {} : store.subscribe(functionName, args)),
    [store, functionName, argsKey, options?.skip]
  );

  const getSnapshot = useMemo(
    () => (options?.skip
      ? () => ({ status: "pending", data: undefined, error: undefined, version: 0, fetchedAt: 0 } as QueryState<T>)
      : store.getSnapshot<T>(functionName, args)),
    [store, functionName, argsKey, options?.skip]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

type MutationStatus = "idle" | "pending" | "success" | "error";

interface MutationState<T> {
  status: MutationStatus;
  data: T | undefined;
  error: Error | undefined;
  isPending: boolean;
}

interface UseMutationResult<T, Args> {
  /** Execute the mutation */
  mutate: (args?: Args, options?: InvokeOptions) => Promise<T>;
  /** Current mutation state */
  status: MutationStatus;
  /** Whether the mutation is currently running */
  isPending: boolean;
  /** The result data (if successful) */
  data: T | undefined;
  /** The error (if failed) */
  error: Error | undefined;
  /** Reset the mutation state */
  reset: () => void;
}

const IDLE_STATE: MutationState<never> = {
  status: "idle",
  data: undefined,
  error: undefined,
  isPending: false,
};

/**
 * Get a mutation function for calling mutations
 *
 * @example
 * ```tsx
 * const { mutate: createTodo, isPending } = useMutation("create_todo");
 *
 * const handleSubmit = async () => {
 *   await createTodo({ title: "New todo", user_id: "123" });
 * };
 *
 * return (
 *   <button onClick={handleSubmit} disabled={isPending}>
 *     {isPending ? "Creating..." : "Create Todo"}
 *   </button>
 * );
 * ```
 */
export function useMutation<T = unknown, Args extends Record<string, unknown> = Record<string, unknown>>(
  functionName: string
): UseMutationResult<T, Args> {
  const { store } = useAizu();
  const client = store.getClient();
  const [state, setState] = useState<MutationState<T>>(IDLE_STATE as MutationState<T>);

  const mutate = useCallback(
    async (args?: Args, options?: InvokeOptions): Promise<T> => {
      setState({ status: "pending", data: undefined, error: undefined, isPending: true });

      try {
        const result = await client.mutation<T, Args>(functionName, args, options);
        setState({ status: "success", data: result, error: undefined, isPending: false });
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        setState({ status: "error", data: undefined, error: err, isPending: false });
        throw error;
      }
    },
    [client, functionName]
  );

  const reset = useCallback(() => {
    setState(IDLE_STATE as MutationState<T>);
  }, []);

  return {
    mutate,
    status: state.status,
    isPending: state.isPending,
    data: state.data,
    error: state.error,
    reset,
  };
}

interface UseActionResult<T, Args> {
  /** Execute the action */
  execute: (args?: Args, options?: InvokeOptions) => Promise<T>;
  /** Current state */
  status: MutationStatus;
  /** Whether the action is currently running */
  isPending: boolean;
  /** The result data (if successful) */
  data: T | undefined;
  /** The error (if failed) */
  error: Error | undefined;
  /** Reset the state */
  reset: () => void;
}

/**
 * Execute a one-shot query (no subscription)
 *
 * Use this for queries that don't need real-time updates,
 * or for actions that have side effects.
 *
 * @example
 * ```tsx
 * const { execute: fetchTodo, data, isPending } = useAction("get_todo");
 *
 * // Call imperatively
 * <button onClick={() => fetchTodo({ id: todoId })}>Load</button>
 * ```
 */
export function useAction<T = unknown, Args extends Record<string, unknown> = Record<string, unknown>>(
  functionName: string
): UseActionResult<T, Args> {
  const { store } = useAizu();
  const client = store.getClient();
  const [state, setState] = useState<MutationState<T>>(IDLE_STATE as MutationState<T>);

  const execute = useCallback(
    async (args?: Args, options?: InvokeOptions): Promise<T> => {
      setState({ status: "pending", data: undefined, error: undefined, isPending: true });

      try {
        const result = await client.query<T, Args>(functionName, args, options);
        setState({ status: "success", data: result, error: undefined, isPending: false });
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        setState({ status: "error", data: undefined, error: err, isPending: false });
        throw error;
      }
    },
    [client, functionName]
  );

  const reset = useCallback(() => {
    setState(IDLE_STATE as MutationState<T>);
  }, []);

  return {
    execute,
    status: state.status,
    isPending: state.isPending,
    data: state.data,
    error: state.error,
    reset,
  };
}

/**
 * Get the current authenticated user
 *
 * Returns the cached user immediately (from localStorage).
 * The auth module refreshes from the server in the background on init.
 */
export function useCurrentUser(): User | null {
  const { auth } = useAizu();

  const subscribe = useCallback(
    (onStoreChange: () => void) => auth.onAuthStateChange(() => onStoreChange()),
    [auth]
  );

  const getSnapshot = useCallback(() => auth.getUser(), [auth]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Check if user is authenticated
 */
export function useIsAuthenticated(): boolean {
  const { auth } = useAizu();

  const subscribe = useCallback(
    (onStoreChange: () => void) => auth.onAuthStateChange(() => onStoreChange()),
    [auth]
  );

  const getSnapshot = useCallback(() => auth.isAuthenticated(), [auth]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Get the storage client for file uploads/downloads
 *
 * @example
 * ```tsx
 * const storage = useStorage();
 * const handleUpload = async (file: File) => {
 *   const { storageId, url } = await storage.upload(file);
 * };
 * ```
 */
export function useStorage(): AizuStorage {
  const { store } = useAizu();
  const client = store.getClient();
  return useMemo(() => client.storage, [client]);
}

export type {
  AizuConfig,
  User,
  AuthTokens,
  InvokeOptions,
  Subscription,
  StorageFile,
} from "./types";

export type { QueryState } from "./store";

export { AizuClient } from "./client";
export { AizuAuth } from "./auth";
export { AizuStorage } from "./storage";
export { SubscriptionClient } from "./subscriptions";
export { QueryStore } from "./store";
