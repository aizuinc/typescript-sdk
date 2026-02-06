/**
 * Aizu Auth - Authentication helpers
 */

import {
  AizuConfig,
  AuthTokens,
  User,
  RegisterOptions,
  LoginOptions,
  MagicLinkOptions,
  ResetPasswordOptions,
  AizuError,
  AuthError,
} from "./types";

interface AuthResponse {
  user: User;
  tokens: AuthTokens;
}

interface UserResponse {
  user: User;
}

interface TokenResponse {
  tokens: AuthTokens;
}

export class AizuAuth {
  private baseUrl: string;
  private project?: string;
  private tokens: AuthTokens | null = null;
  private user: User | null = null;
  private refreshPromise: Promise<AuthTokens> | null = null;
  private authListeners: Set<(user: User | null) => void> = new Set();

  constructor(config: AizuConfig) {
    this.baseUrl = config.url.replace(/\/$/, "");
    this.project = config.project;
  }

  /**
   * Register a new user
   */
  async register(options: RegisterOptions): Promise<{ user: User; tokens: AuthTokens }> {
    const response = await this.request<AuthResponse>("/auth/register", {
      method: "POST",
      body: options,
    });

    this.setTokens(response.tokens);
    this.setUser(response.user);

    return response;
  }

  /**
   * Login with email and password
   */
  async login(options: LoginOptions): Promise<{ user: User; tokens: AuthTokens }> {
    const response = await this.request<AuthResponse>("/auth/login", {
      method: "POST",
      body: options,
    });

    this.setTokens(response.tokens);
    this.setUser(response.user);

    return response;
  }

  /**
   * Logout the current user
   */
  async logout(): Promise<void> {
    if (this.tokens) {
      try {
        await this.request("/auth/logout", {
          method: "POST",
          token: this.tokens.accessToken,
        });
      } catch {
        // Ignore logout errors
      }
    }

    this.tokens = null;
    this.user = null;
    this.clearStorage();
    this.notifyAuthListeners(null);
  }

  /**
   * Get the current user
   */
  async getCurrentUser(): Promise<User | null> {
    if (!this.tokens) {
      return null;
    }

    try {
      const token = await this.getAccessToken();
      if (!token) return null;

      const response = await this.request<UserResponse>("/auth/me", {
        method: "GET",
        token,
      });

      this.setUser(response.user);
      return response.user;
    } catch {
      return null;
    }
  }

  /**
   * Send a magic link email
   */
  async sendMagicLink(options: MagicLinkOptions): Promise<void> {
    await this.request("/auth/magic-link", {
      method: "POST",
      body: options,
    });
  }

  /**
   * Verify a magic link token
   */
  async verifyMagicLink(token: string): Promise<{ user: User; tokens: AuthTokens }> {
    const response = await this.request<AuthResponse>("/auth/magic-link/verify", {
      method: "POST",
      body: { token },
    });

    this.setTokens(response.tokens);
    this.setUser(response.user);

    return response;
  }

  /**
   * Request a password reset email
   */
  async forgotPassword(email: string): Promise<void> {
    await this.request("/auth/forgot-password", {
      method: "POST",
      body: { email },
    });
  }

  /**
   * Reset password with token
   */
  async resetPassword(options: ResetPasswordOptions): Promise<void> {
    await this.request("/auth/reset-password", {
      method: "POST",
      body: options,
    });
  }

  /**
   * Change the current user's password
   */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) throw new AuthError("Not authenticated");

    await this.request("/auth/change-password", {
      method: "POST",
      token,
      body: { current_password: currentPassword, new_password: newPassword },
    });
  }

  /**
   * Verify email with token
   */
  async verifyEmail(token: string): Promise<void> {
    await this.request("/auth/verify-email", {
      method: "POST",
      body: { token },
    });
  }

  /**
   * Resend verification email
   */
  async resendVerification(): Promise<void> {
    const token = await this.getAccessToken();
    if (!token) throw new AuthError("Not authenticated");

    await this.request("/auth/resend-verification", {
      method: "POST",
      token,
    });
  }

  /**
   * Get a valid access token, refreshing if necessary
   */
  async getAccessToken(): Promise<string | null> {
    if (!this.tokens) {
      return null;
    }

    // Check if token is expired (with 60s buffer)
    const now = Date.now();
    if (this.tokens.expiresAt - now < 60000) {
      return this.refreshAccessToken();
    }

    return this.tokens.accessToken;
  }

  /**
   * Refresh the access token
   */
  private async refreshAccessToken(): Promise<string> {
    if (!this.tokens?.refreshToken) {
      throw new AuthError("No refresh token available");
    }

    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) {
      const tokens = await this.refreshPromise;
      return tokens.accessToken;
    }

    this.refreshPromise = this.doRefresh();

    try {
      const tokens = await this.refreshPromise;
      return tokens.accessToken;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async doRefresh(): Promise<AuthTokens> {
    const response = await this.request<TokenResponse>("/auth/refresh", {
      method: "POST",
      body: { refresh_token: this.tokens!.refreshToken },
    });

    this.setTokens(response.tokens);
    return response.tokens;
  }

  /**
   * Set tokens and persist to storage
   */
  private setTokens(tokens: AuthTokens): void {
    this.tokens = tokens;

    // Persist to localStorage if available
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("aizu_tokens", JSON.stringify(tokens));
    }
  }

  /**
   * Set user and notify listeners
   */
  private setUser(user: User): void {
    this.user = user;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem("aizu_user", JSON.stringify(user));
    }
    this.notifyAuthListeners(user);
  }

  /**
   * Notify all auth listeners
   */
  private notifyAuthListeners(user: User | null): void {
    this.authListeners.forEach((listener) => listener(user));
  }

  /**
   * Load tokens from storage
   */
  loadFromStorage(): void {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem("aizu_tokens");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          // Validate token structure
          if (
            parsed &&
            typeof parsed.accessToken === "string" &&
            typeof parsed.refreshToken === "string" &&
            typeof parsed.expiresAt === "number"
          ) {
            this.tokens = parsed;
          } else {
            // Invalid token structure, clear storage
            localStorage.removeItem("aizu_tokens");
          }
        } catch {
          // Invalid JSON, clear storage
          localStorage.removeItem("aizu_tokens");
        }
      }

      // Restore cached user so it's available immediately (no HTTP round trip)
      const storedUser = localStorage.getItem("aizu_user");
      if (storedUser && this.tokens) {
        try {
          this.user = JSON.parse(storedUser);
        } catch {
          localStorage.removeItem("aizu_user");
        }
      }

      // Background refresh: fetch latest user from server without blocking.
      // This keeps the cached user fresh and notifies subscribers via
      // onAuthStateChange, so React hooks update via useSyncExternalStore.
      if (this.tokens) {
        this.getCurrentUser().catch(() => {});
      }
    }
  }

  /**
   * Clear stored tokens
   */
  clearStorage(): void {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem("aizu_tokens");
      localStorage.removeItem("aizu_user");
    }
  }

  /**
   * Subscribe to auth state changes
   */
  onAuthStateChange(callback: (user: User | null) => void): () => void {
    this.authListeners.add(callback);
    return () => {
      this.authListeners.delete(callback);
    };
  }

  /**
   * Check if user is authenticated
   */
  isAuthenticated(): boolean {
    return !!this.tokens &&
           typeof this.tokens.expiresAt === 'number' &&
           this.tokens.expiresAt > Date.now();
  }

  /**
   * Get current user (synchronous, returns cached value)
   */
  getUser(): User | null {
    return this.user;
  }

  /**
   * Make an authenticated request
   */
  private async request<T = unknown>(
    path: string,
    options: {
      method: string;
      body?: unknown;
      token?: string;
    }
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.project) {
      headers["X-Aizu-Project"] = this.project;
    }

    if (options.token) {
      headers["Authorization"] = `Bearer ${options.token}`;
    }

    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: response.statusText }));
      throw new AizuError(
        error.error?.message || error.message || "Request failed",
        error.error?.code || "auth_error",
        response.status
      );
    }

    // Handle empty responses
    const text = await response.text();
    if (!text) {
      return {} as T;
    }

    return JSON.parse(text);
  }
}
