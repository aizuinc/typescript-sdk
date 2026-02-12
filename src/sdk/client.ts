/**
 * Aizu Client - Core HTTP client for function invocation
 */

import {
  AizuConfig,
  InvokeOptions,
  InvokeResult,
  AizuError,
  NetworkError,
  AuthError,
  NotFoundError,
  TimeoutError,
} from "./types";
import { AizuStorage } from "./storage";

export class AizuClient {
  private config: Required<Omit<AizuConfig, "token" | "project">> & { token?: AizuConfig["token"]; project?: string };
  private _storage: AizuStorage | null = null;

  constructor(config: AizuConfig) {
    this.config = {
      url: config.url.replace(/\/$/, ""), // Remove trailing slash
      project: config.project,
      token: config.token,
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false,
    };
  }

  /**
   * Invoke a WASM function
   *
   * @example
   * ```ts
   * const result = await client.invoke("list_todos", { user_id: "123" });
   * console.log(result.output);
   * ```
   */
  async invoke<T = unknown, Args extends Record<string, unknown> = Record<string, unknown>>(
    functionName: string,
    args?: Args,
    options?: InvokeOptions
  ): Promise<T> {
    const url = `${this.config.url}/invoke/${functionName}`;
    const token = options?.token ?? (await this.getToken());
    const timeout = options?.timeout ?? this.config.timeout;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.config.project) {
      headers["X-Aizu-Project"] = this.config.project;
    }

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      this.log("invoke", functionName, args);

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(args ?? {}),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        await this.handleErrorResponse(response, functionName);
      }

      const result: InvokeResult<T> = await response.json();
      this.log("invoke result", functionName, result.output);

      return result.output;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof AizuError) {
        throw error;
      }

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new TimeoutError(`Function '${functionName}' timed out after ${timeout}ms`);
        }
        throw new NetworkError(error.message);
      }

      throw new NetworkError("Unknown error occurred");
    }
  }

  /**
   * Execute a mutation (alias for invoke, for semantic clarity)
   */
  async mutation<T = unknown, Args extends Record<string, unknown> = Record<string, unknown>>(
    functionName: string,
    args?: Args,
    options?: InvokeOptions
  ): Promise<T> {
    return this.invoke<T, Args>(functionName, args, options);
  }

  /**
   * Execute a query (alias for invoke, for semantic clarity)
   */
  async query<T = unknown, Args extends Record<string, unknown> = Record<string, unknown>>(
    functionName: string,
    args?: Args,
    options?: InvokeOptions
  ): Promise<T> {
    return this.invoke<T, Args>(functionName, args, options);
  }

  /**
   * Make an HTTP request to a custom route
   */
  async http<T = unknown>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      token?: string;
    }
  ): Promise<T> {
    let url = `${this.config.url}${path}`;

    if (options?.query) {
      const params = new URLSearchParams(options.query);
      url += `?${params.toString()}`;
    }

    const token = options?.token ?? (await this.getToken());
    const headers: Record<string, string> = {
      ...options?.headers,
    };

    if (this.config.project) {
      headers["X-Aizu-Project"] = this.config.project;
    }

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    if (options?.body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new AizuError(
        error.error?.message || error.message || "Request failed",
        error.error?.code || "http_error",
        response.status
      );
    }

    return response.json();
  }

  /**
   * Get the storage client for file uploads/downloads
   */
  get storage(): AizuStorage {
    if (!this._storage) {
      this._storage = new AizuStorage(
        () => this.config.url,
        async () => {
          const headers: Record<string, string> = {};
          if (this.config.project) {
            headers["X-Aizu-Project"] = this.config.project;
          }
          const token = await this.getToken();
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }
          return headers;
        }
      );
    }
    return this._storage;
  }

  /**
   * Get the current auth token
   */
  private async getToken(): Promise<string | null> {
    if (!this.config.token) {
      return null;
    }

    if (typeof this.config.token === "string") {
      return this.config.token;
    }

    const result = this.config.token();
    if (result instanceof Promise) {
      return await result;
    }
    return result;
  }

  /**
   * Handle error responses
   */
  private async handleErrorResponse(response: Response, functionName: string): Promise<never> {
    let error: { error?: { code?: string; message?: string }; message?: string };

    try {
      error = await response.json();
    } catch {
      error = { message: response.statusText };
    }

    const message = error.error?.message || error.message || "Request failed";
    const code = error.error?.code || "unknown";

    switch (response.status) {
      case 401:
        throw new AuthError(message);
      case 404:
        throw new NotFoundError(`Function '${functionName}' not found`);
      case 504:
        throw new TimeoutError(message);
      default:
        throw new AizuError(message, code, response.status);
    }
  }

  /**
   * Debug logging
   */
  private log(...args: unknown[]): void {
    if (this.config.debug) {
      console.log("[Aizu]", ...args);
    }
  }
}
