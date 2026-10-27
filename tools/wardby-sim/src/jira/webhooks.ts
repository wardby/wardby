// TEST ONLY (wardby-sim). Jira Cloud webhook deliveries (a webhook registered with a secret,
// per Atlassian's documentation; unverified against a recorded delivery):
//
//   X-Hub-Signature                  "sha256=" + HMAC-SHA256(secret, raw body), hex (WebSub style)
//   X-Atlassian-Webhook-Identifier   one id per delivery, the same on every retry of it
//   X-Atlassian-Webhook-Retry        the retry number, on retries only
//
// Jira retries a delivery that failed (non-2xx or a transport error); the simulator makes up to
// `attempts` attempts (default 3, Jira's own is up to 5 over hours) a short delay apart, with the
// same identifier, and keeps a delivery log. Every payload has an epoch-ms `timestamp`.
import { createHmac, randomUUID } from "node:crypto";
import type { JiraState, JiraSubscription } from "./state.js";

export interface JiraDeliveryAttempt {
  at: string;
  status: number | null;
  error?: string;
}

export interface JiraDelivery {
  id: string;
  event: string;
  url: string;
  body: string;
  attempts: JiraDeliveryAttempt[];
  delivered: boolean;
  redelivery: boolean;
}

export interface JiraWebhookOptions {
  attempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export function signJiraBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export class JiraWebhooks {
  readonly deliveries: JiraDelivery[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly attempts: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;
  private paused = false;
  private held: (() => void)[] = [];

  constructor(
    private readonly jira: JiraState,
    options: JiraWebhookOptions = {},
  ) {
    this.attempts = options.attempts ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 50;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
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

  /**
   * Sends an event to every subscription that takes it. `build` makes the payload in the
   * subscription's body format (a wiki string or ADF), so one event can differ per subscription.
   */
  send(event: string, build: (subscription: JiraSubscription) => Record<string, unknown>): JiraDelivery[] {
    const created: JiraDelivery[] = [];
    for (const subscription of this.jira.subscriptions) {
      if (subscription.events.length > 0 && !subscription.events.includes(event)) continue;
      const body = JSON.stringify({ timestamp: Date.now(), webhookEvent: event, ...build(subscription) });
      const delivery: JiraDelivery = {
        id: randomUUID(),
        event,
        url: subscription.url,
        body,
        attempts: [],
        delivered: false,
        redelivery: false,
      };
      this.deliveries.push(delivery);
      created.push(delivery);
      this.queue = this.queue.then(() => this.deliver(delivery, subscription.secret));
    }
    return created;
  }

  /** Sends a past delivery again, byte for byte, with the same identifier (a duplicate delivery). */
  redeliver(id: string): JiraDelivery | undefined {
    const original = this.deliveries.find((d) => d.id === id);
    const subscription = original && this.jira.subscriptions.find((s) => s.url === original.url);
    if (!original || !subscription) return undefined;
    const copy: JiraDelivery = { ...original, attempts: [], delivered: false, redelivery: true };
    this.deliveries.push(copy);
    this.queue = this.queue.then(() => this.deliver(copy, subscription.secret));
    return copy;
  }

  async idle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  private async deliver(delivery: JiraDelivery, secret: string): Promise<void> {
    if (this.paused) await new Promise<void>((resolve) => this.held.push(resolve));
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      const record: JiraDeliveryAttempt = { at: new Date().toISOString(), status: null };
      delivery.attempts.push(record);
      try {
        const response = await this.fetchImpl(delivery.url, {
          method: "POST",
          headers: {
            "content-type": "application/json; charset=utf-8",
            "user-agent": "Atlassian Webhook HTTP Client (wardby-sim)",
            "x-atlassian-webhook-identifier": delivery.id,
            ...(attempt > 1 ? { "x-atlassian-webhook-retry": String(attempt - 1) } : {}),
            "x-hub-signature": signJiraBody(delivery.body, secret),
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
