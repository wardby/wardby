// TEST ONLY (wardby-sim). GitHub App webhook deliveries: every state change GitHub would send
// an event for goes to each subscription, signed like GitHub signs it:
//
//   X-GitHub-Event        the event name
//   X-GitHub-Delivery     a fresh UUID per delivery (kept on every redelivery of it)
//   X-Hub-Signature-256   "sha256=" + HMAC-SHA256(secret, raw body), hex
//
// GitHub itself does not retry a failed delivery; it is redelivered by hand or by the App
// owner's own redelivery job, with the same delivery GUID. The simulator models that as up
// to `attempts` deliveries (default 3) on a non-2xx answer or a transport error, each with
// the same GUID, and keeps a delivery log a test asserts on.
import { createHmac, randomUUID } from "node:crypto";
import { repoJson, userJson } from "./shapes.js";
import type { GitHubState, SimRepo, SimUser } from "./state.js";

export interface DeliveryAttempt {
  at: string;
  status: number | null;
  error?: string;
}

export interface Delivery {
  id: string;
  event: string;
  action: string | null;
  url: string;
  body: string;
  attempts: DeliveryAttempt[];
  delivered: boolean;
  redelivery: boolean;
}

export interface WebhookOptions {
  attempts?: number;
  /** Delay before each retry, ms (default 50: tests stay fast). */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export class WebhookDispatcher {
  readonly deliveries: Delivery[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  /** Paused deliveries wait here (a test reads `deliveries` before they go out). */
  private paused = false;
  private held: (() => void)[] = [];

  constructor(
    private readonly gh: GitHubState,
    options: WebhookOptions = {},
  ) {
    this.attempts = options.attempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    gh.emit = (event, payload, repo, sender) => this.emit(event, payload, repo, sender);
  }

  reset(): void {
    this.deliveries.length = 0;
    this.paused = false;
    for (const release of this.held.splice(0)) release();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    for (const release of this.held.splice(0)) release();
  }

  /** The full payload GitHub sends: the event's own fields plus repository, sender, installation. */
  payloadFor(payload: Record<string, unknown>, repo: SimRepo, sender: SimUser): Record<string, unknown> {
    return {
      ...payload,
      repository: repoJson(this.gh, repo),
      sender: userJson(sender),
      installation: { id: repo.installationId, node_id: `MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u${repo.installationId}` },
    };
  }

  emit(event: string, payload: Record<string, unknown>, repo: SimRepo, sender: SimUser): Delivery[] {
    return this.send(event, this.payloadFor(payload, repo, sender));
  }

  /** Sends an event's exact payload to every subscription that takes it. */
  send(event: string, fullPayload: Record<string, unknown>, options: { deliveryId?: string } = {}): Delivery[] {
    const created: Delivery[] = [];
    const body = JSON.stringify(fullPayload);
    for (const subscription of this.gh.webhooks) {
      if (subscription.events.length > 0 && !subscription.events.includes(event)) continue;
      const delivery: Delivery = {
        id: options.deliveryId ?? randomUUID(),
        event,
        action: typeof fullPayload.action === "string" ? fullPayload.action : null,
        url: subscription.url,
        body,
        attempts: [],
        delivered: false,
        redelivery: options.deliveryId !== undefined,
      };
      this.deliveries.push(delivery);
      created.push(delivery);
      this.queue = this.queue.then(() => this.deliver(delivery, subscription.secret));
    }
    return created;
  }

  /** Sends a past delivery again with the same GUID (GitHub's "Redeliver"). */
  redeliver(id: string): Delivery | undefined {
    const original = this.deliveries.find((d) => d.id === id);
    if (!original) return undefined;
    const subscription = this.gh.webhooks.find((s) => s.url === original.url);
    if (!subscription) return undefined;
    const copy: Delivery = { ...original, attempts: [], delivered: false, redelivery: true };
    this.deliveries.push(copy);
    this.queue = this.queue.then(() => this.deliver(copy, subscription.secret));
    return copy;
  }

  /** Resolves once every queued delivery (and its retries) has finished. */
  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  private async deliver(delivery: Delivery, secret: string): Promise<void> {
    if (this.paused) await new Promise<void>((resolve) => this.held.push(resolve));
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      const record: DeliveryAttempt = { at: new Date().toISOString(), status: null };
      delivery.attempts.push(record);
      try {
        const response = await this.fetchImpl(delivery.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "GitHub-Hookshot/wardby-sim",
            "x-github-event": delivery.event,
            "x-github-delivery": delivery.id,
            "x-github-hook-id": "1",
            "x-github-hook-installation-target-type": "integration",
            "x-github-hook-installation-target-id": String(this.gh.app.id),
            "x-hub-signature-256": signBody(delivery.body, secret),
          },
          body: delivery.body,
        });
        record.status = response.status;
        await response.arrayBuffer().catch(() => undefined);
        if (response.status >= 200 && response.status < 300) {
          delivery.delivered = true;
          return;
        }
      } catch (error) {
        record.error = (error as Error).name;
      }
    }
  }
}
