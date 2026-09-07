/**
 * Storage seam — object/blob storage (email attachments, run artifacts).
 *
 * Default adapter: LocalBlobStore (filesystem).
 * Native adapter:  S3BlobStore (S3 or S3-compatible object storage).
 */

export interface BlobStore {
  put(key: string, body: Buffer, opts?: { contentType?: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Pre-signed URL for direct client GET/PUT without proxying through the app. */
  signedUrl(key: string, opts: { expiresSec: number; method: "GET" | "PUT" }): Promise<string>;
}
