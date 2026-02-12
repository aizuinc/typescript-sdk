/**
 * Aizu Storage - File storage client
 *
 * Upload, download, and manage files stored in Aizu's S3-backed storage.
 *
 * @example
 * ```ts
 * const client = new AizuClient({ url: "https://myproject.aizu.sh" });
 * const { storageId, url } = await client.storage.upload(file);
 * const downloadUrl = client.storage.getUrl(storageId);
 * ```
 */

import type { StorageListResult } from "./types";

export class AizuStorage {
  constructor(
    private getBaseUrl: () => string,
    private getHeaders: () => Promise<Record<string, string>>
  ) {}

  /**
   * Upload a file to storage.
   *
   * @param file - File or Blob to upload
   * @param options - Upload options
   * @returns The storage ID and URL for the uploaded file
   *
   * @example
   * ```ts
   * const input = document.querySelector<HTMLInputElement>('input[type="file"]');
   * const file = input.files[0];
   * const result = await storage.upload(file);
   * console.log(result.storageId, result.url);
   * ```
   */
  async upload(
    file: File | Blob,
    options?: { metadata?: Record<string, unknown>; filename?: string; folder?: string }
  ): Promise<{ storageId: string; url: string; filename: string; contentType: string; size: number; folder: string }> {
    const url = `${this.getBaseUrl()}/storage/upload`;
    const headers = await this.getHeaders();

    const formData = new FormData();
    formData.append("file", file, options?.filename ?? (file instanceof File ? file.name : "blob"));

    if (options?.metadata) {
      formData.append("metadata", JSON.stringify(options.metadata));
    }

    if (options?.folder) {
      formData.append("folder", options.folder);
    }

    // Don't set Content-Type header — let the browser set it with the boundary
    delete headers["Content-Type"];

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(error.error?.message || "Upload failed");
    }

    return response.json();
  }

  /**
   * Get the URL for a stored file.
   * This URL can be used directly in <img src>, fetch(), etc.
   *
   * @param storageId - The storage file ID
   * @returns The URL to access the file
   */
  getUrl(storageId: string): string {
    return `${this.getBaseUrl()}/storage/${storageId}`;
  }

  /**
   * Delete a file from storage.
   *
   * @param storageId - The storage file ID to delete
   */
  async delete(storageId: string): Promise<void> {
    const url = `${this.getBaseUrl()}/storage/${storageId}`;
    const headers = await this.getHeaders();

    const response = await fetch(url, {
      method: "DELETE",
      headers,
    });

    if (!response.ok && response.status !== 204) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(error.error?.message || "Delete failed");
    }
  }

  /**
   * List files in storage for the current project.
   *
   * @param options - Filtering and pagination options
   * @returns Array of storage file metadata
   */
  async list(options?: {
    limit?: number;
    offset?: number;
    contentType?: string;
    prefix?: string;
    delimiter?: string;
  }): Promise<StorageListResult> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.contentType) params.set("content_type", options.contentType);
    if (options?.prefix) params.set("prefix", options.prefix);
    if (options?.delimiter) params.set("delimiter", options.delimiter);

    const query = params.toString();
    const url = `${this.getBaseUrl()}/storage${query ? `?${query}` : ""}`;
    const headers = await this.getHeaders();

    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(error.error?.message || "List failed");
    }

    return response.json();
  }
}
