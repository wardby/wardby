/**
 * Process wiring for workflow notifications: installs the outbox recorder
 * as the workflow-event sink and starts the lease-gated dispatcher. Safe in
 * every replica (the dispatcher elects one sender via SchedulerLease).
 * Without a configured chat provider only the recorder is installed (run
 * hooks still need events); no Slack dispatcher starts.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "#prisma";
import type { ChatProviderRegistry } from "../providers/chat/types.js";
import { logger } from "./logger.js";
import { startNotificationDispatcher } from "./notification-dispatcher.js";
import { createWorkflowEventRecorder } from "./workflow-event-recorder.js";
import { setWorkflowEventSink } from "./workflow-events.js";

const log = logger.child({ module: "notifications" });

/** Always installed: run hooks need recorded events even when no chat provider is configured. */
export function installWorkflowEventRecorder(db: PrismaClient, chat: ChatProviderRegistry): void {
  setWorkflowEventSink(createWorkflowEventRecorder(db, Object.keys(chat)));
}

export async function startNotifications(opts: {
  db: PrismaClient;
  chat: ChatProviderRegistry;
  holder?: string;
}): Promise<{ stop(): void }> {
  installWorkflowEventRecorder(opts.db, opts.chat);
  if (Object.keys(opts.chat).length === 0) return { stop() {} };
  // Identity checks run in the background: Slack being slow or unreachable
  // must never delay process startup. The dispatcher starts immediately
  // regardless; a failed check just logs (dispatch itself re-checks auth
  // on an auth_failed delivery error).
  for (const provider of Object.values(opts.chat)) {
    void provider
      .authTest()
      .then((who) => {
        log.info({ provider: provider.name, team: who.team, botUserId: who.botUserId }, "chat notifications acting as");
      })
      .catch((err: unknown) => {
        log.error(
          { err, provider: provider.name },
          "chat provider auth check failed; deliveries will pause until it succeeds",
        );
      });
  }
  return startNotificationDispatcher({ db: opts.db, chat: opts.chat, holder: opts.holder ?? `notify-${randomUUID()}` });
}
