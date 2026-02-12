/**
 * Aizu Client SDK
 *
 * A TypeScript SDK for building applications with Aizu,
 * providing Convex-style reactive queries and mutations.
 *
 * @example
 * ```ts
 * import { AizuClient } from "aizu";
 *
 * const client = new AizuClient({
 *   url: "https://myproject.aizu.sh",
 * });
 *
 * // Execute a query
 * const todos = await client.query("list_todos", { user_id: "123" });
 *
 * // Execute a mutation
 * const newTodo = await client.mutation("create_todo", {
 *   user_id: "123",
 *   title: "Buy milk",
 * });
 * ```
 *
 * For React applications, use the hooks from `aizu/react`:
 *
 * @example
 * ```tsx
 * import { AizuProvider, useQuery, useMutation } from "aizu/react";
 *
 * function App() {
 *   return (
 *     <AizuProvider url="https://myproject.aizu.sh">
 *       <TodoApp />
 *     </AizuProvider>
 *   );
 * }
 *
 * function TodoApp() {
 *   // Automatically updates when data changes
 *   const todos = useQuery("list_todos", { user_id: "123" });
 *
 *   // Mutation function with loading state
 *   const { mutate: createTodo, isPending } = useMutation("create_todo");
 *
 *   if (todos === undefined) {
 *     return <div>Loading...</div>;
 *   }
 *
 *   return (
 *     <div>
 *       {todos.map(todo => (
 *         <div key={todo.id}>{todo.title}</div>
 *       ))}
 *       <button
 *         onClick={() => createTodo({ user_id: "123", title: "New todo" })}
 *         disabled={isPending}
 *       >
 *         Add Todo
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @packageDocumentation
 */

// Core client
export { AizuClient } from "./client";

// Storage
export { AizuStorage } from "./storage";

// Authentication
export { AizuAuth } from "./auth";

// Subscriptions
export { SubscriptionClient } from "./subscriptions";

// Query Store (for advanced usage)
export { QueryStore, type QueryState } from "./store";

// Types
export type {
  AizuConfig,
  InvokeOptions,
  InvokeResult,
  AuthTokens,
  User,
  RegisterOptions,
  LoginOptions,
  MagicLinkOptions,
  ResetPasswordOptions,
  StorageFile,
  StorageListResult,
  Subscription,
  SubscriptionOptions,
} from "./types";

// Errors
export {
  AizuError,
  NetworkError,
  AuthError,
  NotFoundError,
  TimeoutError,
} from "./types";
