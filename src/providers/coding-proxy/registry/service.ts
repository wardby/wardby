/**
 * RegistryService: the security core of the coding package registry. It
 * authenticates the registry-only token, enforces the per-run allowlist and
 * the dependency graph grown from it, filters versions by allowlisted
 * range, minimum release age and OSV advisories, streams downloads with
 * integrity verification and size/idle limits, and records every served or
 * refused fetch. Adapters (npm, PyPI, …) supply ecosystem-specific parsing
 * and protocol only; every safeguard lives here so a new adapter cannot
 * weaken one by omission.
 */
import { createHash } from "node:crypto";
import { matchRoot, parseAllowlist, resolvePolicy } from "../../../coding/registry/allowlist.js";
import {
  RegistryError,
  type AllowlistEntry,
  type DownloadRoute,
  type FileMetadataRoute,
  type FileRef,
  type PackageMetadata,
  type RegistryAdapter,
  type UpstreamFetch,
} from "../../../coding/registry/types.js";
import { capabilityHash } from "../proxy.js";
import type { OsvAudit } from "./audit.js";
import type { RegistryRunContext, RegistryStore } from "./store.js";

const DAY_MS = 86_400_000;
const DEPENDENCY_BUFFER_LIMIT = 64 * 1024 * 1024;

/** Discriminated result of one `reader.read()` call in `download`'s stream
 *  loop, folding a rejection (`ok: false`) into the same shape as a
 *  resolution so the pending-read race can be checked once, uniformly. */
type ReadOutcome = { ok: false } | { ok: true; done: true } | { ok: true; done: false; value: Uint8Array };

export interface RegistryLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  idleTimeoutMs: number;
}
export type RegistryResponse =
  | { status: number; contentType: string; body: string }
  | { status: 200; contentType: string; stream: ReadableStream<Uint8Array> };
export interface RegistryRequest {
  method: string;
  ecosystem: string;
  subpath: string;
  token: string;
  signal: AbortSignal;
}

export function errorResponse(error: RegistryError): RegistryResponse {
  return {
    status: error.status,
    contentType: "application/json",
    body: JSON.stringify({ error: `${error.code}: ${error.message}` }),
  };
}

export class RegistryService {
  private readonly metadataCache = new Map<string, { expires: number; meta: PackageMetadata }>();
  private readonly now: () => Date;
  private readonly metadataTtlMs: number;

  constructor(
    private readonly options: {
      adapters: ReadonlyMap<string, RegistryAdapter>;
      store: RegistryStore;
      audit: Pick<OsvAudit, "audit">;
      upstream: UpstreamFetch;
      proxyBase: string;
      limits: RegistryLimits;
      now?: () => Date;
      metadataTtlMs?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.metadataTtlMs = options.metadataTtlMs ?? 300_000;
  }

  async handle(request: RegistryRequest): Promise<RegistryResponse> {
    try {
      return await this.dispatch(request);
    } catch (error) {
      if (error instanceof RegistryError) return errorResponse(error);
      return errorResponse(new RegistryError(502, "wardby_upstream_error", "the package registry request failed"));
    }
  }

  private async dispatch(request: RegistryRequest): Promise<RegistryResponse> {
    const adapter = this.options.adapters.get(request.ecosystem);
    if (!adapter) throw new RegistryError(404, "wardby_registry_unknown", `no registry named "${request.ecosystem}"`);
    const context = await this.options.store.findRunByRegistryTokenHash(capabilityHash(request.token), this.now());
    if (!context) throw new RegistryError(401, "invalid_capability", "the registry token is not valid for a live run");
    const route = adapter.route(request.method, request.subpath, new Headers());
    if (!route) throw new RegistryError(404, "wardby_route_unknown", "unknown registry path");

    const name = adapter.normalizeName(route.name);
    const root = await this.authorize(adapter, context, name);
    const meta = await this.metadata(adapter, name);
    const keep = await this.keptVersions(adapter, context, meta, root);

    if (route.kind === "metadata") {
      if (keep.size === 0) {
        await this.refuse(context, adapter, name, "wardby_version_filtered");
        throw new RegistryError(
          404,
          "wardby_version_filtered",
          `every matching version of "${name}" is outside the allowlisted range, newer than the release-age limit, or has a high-severity advisory`,
        );
      }
      const dependencies = [...keep].flatMap((version) => meta.versions.get(version)?.dependencies ?? []);
      await this.options.store.addAllowances(
        context.runId,
        adapter.id,
        dependencies.map((dependency) => adapter.normalizeName(dependency)),
      );
      const document = adapter.renderMetadata(meta, keep, `${this.options.proxyBase}${adapter.id}/`);
      return { status: 200, contentType: document.contentType, body: document.body };
    }

    const file =
      route.kind === "download"
        ? adapter.resolveDownload(route, meta)
        : (adapter.resolveFileMetadata?.(route, meta) ?? null);
    if (!file || !keep.has(file.version)) {
      await this.refuse(context, adapter, name, "wardby_version_filtered", file ?? undefined);
      throw new RegistryError(
        404,
        "wardby_version_filtered",
        `"${name}" ${route.kind === "download" ? route.version : ""} is not available to this run`,
      );
    }
    if (!file.allowed) {
      await this.refuse(context, adapter, name, "wardby_file_not_allowed", file);
      throw new RegistryError(
        403,
        "wardby_file_not_allowed",
        `"${file.filename}" is a source distribution; only wheels are allowed`,
      );
    }
    return this.download(adapter, context, name, route, file, request.signal);
  }

  private async authorize(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    name: string,
  ): Promise<AllowlistEntry | undefined> {
    const entries = parseAllowlist(context.allowlist, this.options.adapters).get(adapter.id) ?? [];
    const root = matchRoot(entries, name);
    if (root || (await this.options.store.isAllowedDependency(context.runId, adapter.id, name))) return root;
    await this.refuse(context, adapter, name, "wardby_package_not_allowed");
    const hint =
      entries.length === 0
        ? `this agent has no ${adapter.id} package allowlist`
        : `"${name}" is not on this agent's ${adapter.id} package allowlist`;
    throw new RegistryError(403, "wardby_package_not_allowed", hint);
  }

  private async metadata(adapter: RegistryAdapter, name: string): Promise<PackageMetadata> {
    const key = `${adapter.id}:${name}`;
    const cached = this.metadataCache.get(key);
    const now = this.now().getTime();
    if (cached && cached.expires > now) return cached.meta;
    const meta = await adapter.fetchMetadata(name, this.options.upstream);
    this.metadataCache.set(key, { expires: now + this.metadataTtlMs, meta });
    return meta;
  }

  private async keptVersions(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    meta: PackageMetadata,
    root: AllowlistEntry | undefined,
  ): Promise<Set<string>> {
    const { minReleaseAgeDays } = resolvePolicy(context.policy);
    const cutoff = this.now().getTime() - minReleaseAgeDays * DAY_MS;
    const advisories = await this.options.audit.audit(adapter.osvEcosystem, meta.name);
    const keep = new Set<string>();
    for (const info of meta.versions.values()) {
      if (root?.range && !adapter.satisfies(info.version, root.range)) continue;
      if (!info.publishedAt || info.publishedAt.getTime() > cutoff) continue;
      if (advisories.withheld.has(info.version)) continue;
      keep.add(info.version);
    }
    return keep;
  }

  private async refuse(
    context: RegistryRunContext,
    adapter: RegistryAdapter,
    name: string,
    reason: string,
    file?: FileRef,
  ) {
    await this.options.store.recordFetch({
      runId: context.runId,
      ecosystem: adapter.id,
      name,
      version: file?.version,
      filename: file?.filename,
      outcome: "refused",
      reason,
    });
  }

  private async download(
    adapter: RegistryAdapter,
    context: RegistryRunContext,
    name: string,
    route: DownloadRoute | FileMetadataRoute,
    file: FileRef,
    signal: AbortSignal,
  ): Promise<RegistryResponse> {
    const { limits, store } = this.options;
    const usage = await store.usage(context.runId);
    if (usage.files >= limits.maxFiles)
      throw new RegistryError(429, "wardby_package_limit", "this run has reached its package file limit");
    if (file.sizeBytes !== null && file.sizeBytes > limits.maxFileBytes) {
      await this.refuse(context, adapter, name, "wardby_package_too_large", file);
      throw new RegistryError(413, "wardby_package_too_large", `"${file.filename}" exceeds the per-file size limit`);
    }
    const upstream = await this.options.upstream(file.upstreamUrl, { signal });
    if (!upstream.ok || !upstream.body)
      throw new RegistryError(502, "wardby_upstream_error", `the registry returned ${upstream.status}`);

    const hash = file.integrity ? createHash(file.integrity.algorithm) : null;
    const buffered: Uint8Array[] = [];
    let bytes = 0;
    let idle: NodeJS.Timeout | undefined;
    // Guards the race the controller flagged: the idle timer's fail() and a
    // pending reader.read() can both try to act on the same controller. Once
    // either the stream has failed or it has recorded a served/refused row,
    // `settled` is true and every later exit path becomes a no-op, so at
    // most one refused/served row is ever recorded and enqueue/close/error
    // are never called on an already-settled controller.
    let settled = false;
    // Cast: undici's ReadableStream defaults its element type to `any`, and
    // `Response.body`'s type carries that through. The bytes are always
    // Uint8Array chunks in practice, so name the type explicitly rather than
    // let `any` leak into every read below.
    const reader = (upstream.body as ReadableStream<Uint8Array>).getReader();
    const remainingTotal = limits.maxTotalBytes - usage.bytes;

    const clearIdle = () => {
      clearTimeout(idle);
      idle = undefined;
    };

    const fail = async (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
      if (settled) return;
      settled = true;
      clearIdle();
      await reader.cancel().catch(() => undefined);
      await this.refuse(context, adapter, name, reason, file);
      controller.error(new RegistryError(502, reason, `download of "${file.filename}" stopped: ${reason}`));
    };

    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (settled) return;
        clearIdle();
        idle = setTimeout(() => void fail(controller, "wardby_download_idle"), limits.idleTimeoutMs);
        const outcome: ReadOutcome = await reader.read().then(
          (result): ReadOutcome =>
            result.done ? { ok: true, done: true } : { ok: true, done: false, value: result.value },
          (): ReadOutcome => ({ ok: false }),
        );
        // The idle timer may have fired and already failed the stream while
        // this read was pending (or canceled the reader, causing the
        // rejection above); a late resolution must never enqueue, close, or
        // record on top of that already-settled outcome.
        if (settled) return;
        clearIdle();
        if (!outcome.ok) return fail(controller, "wardby_upstream_error");
        if (outcome.done) {
          if (hash && hash.digest("hex") !== file.integrity!.hex) return fail(controller, "wardby_integrity_mismatch");
          settled = true;
          await store.recordFetch({
            runId: context.runId,
            ecosystem: adapter.id,
            name,
            version: file.version,
            filename: file.filename,
            integrity: file.integrity ? `${file.integrity.algorithm}:${file.integrity.hex}` : undefined,
            sizeBytes: bytes,
            outcome: "served",
          });
          if (adapter.dependenciesFromFile && buffered.length > 0) {
            const body = Buffer.concat(buffered);
            const names = await adapter.dependenciesFromFile(route, body).catch(() => []);
            await store.addAllowances(
              context.runId,
              adapter.id,
              names.map((dependency) => adapter.normalizeName(dependency)),
            );
          }
          controller.close();
          return;
        }
        const { value } = outcome;
        bytes += value.byteLength;
        if (bytes > limits.maxFileBytes) return fail(controller, "wardby_package_too_large");
        if (bytes > remainingTotal) return fail(controller, "wardby_package_limit");
        hash?.update(value);
        if (adapter.dependenciesFromFile && bytes <= DEPENDENCY_BUFFER_LIMIT) buffered.push(value);
        controller.enqueue(value);
      },
      cancel: async () => {
        settled = true;
        clearIdle();
        await reader.cancel().catch(() => undefined);
      },
    });
    const contentType = route.kind === "file-metadata" ? "text/plain" : "application/octet-stream";
    return { status: 200, contentType, stream };
  }
}
