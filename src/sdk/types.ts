/**
 * Aizu Client SDK - Type Definitions
 */

export interface AizuConfig {
  /**
   * The URL of your Aizu deployment.
   * Example: "https://myproject.aizu.sh" or "http://localhost:4000"
   */
  url: string;

  /**
   * Project slug (for dev without subdomain routing).
   * If not provided, project is extracted from subdomain.
   */
  project?: string;

  /**
   * Optional auth token for authenticated requests.
   * Can be a string or a function that returns a token.
   */
  token?: string | (() => string | null) | (() => Promise<string | null>);

  /**
   * Request timeout in milliseconds (default: 30000)
   */
  timeout?: number;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

export interface InvokeOptions {
  /**
   * Override auth token for this request
   */
  token?: string;

  /**
   * Request timeout in milliseconds
   */
  timeout?: number;
}

export interface InvokeResult<T = unknown> {
  output: T;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface User {
  id: string;
  email: string;
  name?: string;
  image?: string;
  emailVerified?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface RegisterOptions {
  email: string;
  password: string;
  name?: string;
}

export interface LoginOptions {
  email: string;
  password: string;
}

export interface MagicLinkOptions {
  email: string;
  redirectUrl?: string;
}

export interface ResetPasswordOptions {
  token: string;
  password: string;
}

export interface SubscriptionOptions<Args = Record<string, unknown>> {
  /**
   * Function arguments
   */
  args?: Args;

  /**
   * Called when new data is received
   */
  onUpdate?: (data: unknown, version: number) => void;

  /**
   * Called on error
   */
  onError?: (error: Error) => void;
}

export interface Subscription {
  /**
   * Subscription ID
   */
  id: string;

  /**
   * Current data version
   */
  version: number;

  /**
   * Unsubscribe from updates
   */
  unsubscribe: () => void;
}

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface SubscribeMessage {
  id: string;
  function: string;
  args: Record<string, unknown>;
  module?: string;
}

export interface ResultMessage {
  id: string;
  data: unknown;
  version: number;
}

export interface UpdateMessage {
  id: string;
  data: unknown;
  version: number;
}

export interface ErrorMessage {
  id: string;
  code: string;
  message: string;
}

export interface StorageFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  sha256?: string;
  metadata?: Record<string, unknown>;
  folder?: string;
  createdAt: string;
}

export interface StorageListResult {
  data: StorageFile[];
  prefixes?: string[];
  prefix?: string;
  delimiter?: string;
}

export class AizuError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number
  ) {
    super(message);
    this.name = "AizuError";
  }
}

export class NetworkError extends AizuError {
  constructor(message: string) {
    super(message, "network_error");
    this.name = "NetworkError";
  }
}

export class AuthError extends AizuError {
  constructor(message: string) {
    super(message, "auth_error", 401);
    this.name = "AuthError";
  }
}

export class NotFoundError extends AizuError {
  constructor(message: string) {
    super(message, "not_found", 404);
    this.name = "NotFoundError";
  }
}

export class TimeoutError extends AizuError {
  constructor(message: string = "Request timed out") {
    super(message, "timeout", 504);
    this.name = "TimeoutError";
  }
}
