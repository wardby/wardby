#!/usr/bin/env node
/**
 * Minimal CLI.
 *
 *   reevo agent create --name <n> --model <m> --prompt <p> --budget <usd> [--schedule "<cron>"] [--timezone <tz>]
 *   reevo agent schedule <name> --cron "<expr>" [--timezone <tz>] [--disable]
 *   reevo run <name>
 *   reevo runs [--agent <name>] [--limit N] [--status <s>]
 *   reevo scheduler [--scope default]
 */

import { parseArgs } from "node:util";
import type { RunStatus } from "@prisma/client";
import { loadProviderConfig } from "./config/providers.js";
import { OpenAiLlmProvider } from "./providers/llm/index.js";
import { InProcessExecutor } from "./providers/executor/index.js";
import type { ProviderRegistry } from "./providers/index.js";
import { prisma } from "./core/db.js";
import { runAgent } from "./core/runner.js";
import { validateCronExpression } from "./core/cron.js";
import { startScheduler } from "./core/scheduler.js";
import { startReconciler } from "./core/reconciler.js";

const RUN_STATUSES: RunStatus[] = ["pending", "running", "succeeded", "failed", "refused", "lost"];

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function buildLlmProvider(): ProviderRegistry["llm"] {
  const config = loadProviderConfig();
  if (config.llm !== "openai") {
    fail(`LLM_PROVIDER "${config.llm}" has no adapter yet (only "openai").`);
  }
  return new OpenAiLlmProvider();
}

async function agentCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      budget: { type: "string" },
      schedule: { type: "string" },
      timezone: { type: "string" },
    },
  });

  if (!values.name || !values.model || !values.prompt || !values.budget) {
    fail("agent create requires --name, --model, --prompt, and --budget.");
  }

  const budgetUsd = Number(values.budget);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    fail(`--budget must be a positive number, got "${values.budget}".`);
  }

  const timezone = values.timezone ?? "UTC";
  if (values.schedule) {
    try {
      validateCronExpression(values.schedule, timezone);
    } catch (err) {
      fail(`invalid --schedule/--timezone: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const agent = await prisma.agent.create({
    data: {
      name: values.name!,
      model: values.model!,
      systemPrompt: values.prompt!,
      budgetUsd,
      schedule: values.schedule ?? null,
      timezone,
    },
  });
  console.log(agent.id);
}

async function agentSchedule(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) {
    fail('agent schedule requires an agent name: reevo agent schedule <name> --cron "<expr>"');
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      cron: { type: "string" },
      timezone: { type: "string" },
      disable: { type: "boolean" },
    },
  });

  const agent = await prisma.agent.findUnique({ where: { name: name! } });
  if (!agent) {
    fail(`unknown agent "${name}".`);
  }

  if (values.disable) {
    await prisma.agent.update({ where: { name: name! }, data: { scheduleEnabled: false } });
    console.log(`schedule disabled for "${name}".`);
    return;
  }

  const timezone = values.timezone ?? agent!.timezone;
  const schedule = values.cron ?? agent!.schedule;
  if (!schedule) {
    fail("no --cron given and the agent has no existing schedule to re-enable.");
  }

  try {
    validateCronExpression(schedule!, timezone);
  } catch (err) {
    fail(`invalid --cron/--timezone: ${err instanceof Error ? err.message : String(err)}`);
  }

  await prisma.agent.update({
    where: { name: name! },
    data: { schedule, timezone, scheduleEnabled: true },
  });
  console.log(`schedule set for "${name}": "${schedule}" (${timezone}).`);
}

async function run(name: string | undefined): Promise<void> {
  if (!name) {
    fail("run requires an agent name: reevo run <name>");
  }

  const llm = buildLlmProvider();

  let run;
  try {
    run = await runAgent(name!, { llm }, prisma, (delta) => {
      process.stdout.write(delta);
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.stdout.write("\n");

  const agent = await prisma.agent.findUnique({ where: { id: run.agentId } });
  const budgetUsd = agent ? Number(agent.budgetUsd) : NaN;

  if (run.status === "succeeded") {
    console.log(
      `✓ run ${run.id} — ${run.tokensIn} in / ${run.tokensOut} out — ` +
        `$${Number(run.costUsd).toFixed(6)} (budget $${budgetUsd.toFixed(4)})`,
    );
  } else {
    console.error(`✗ run ${run.id} — ${run.status}: ${run.error ?? "unknown error"}`);
    process.exitCode = 1;
  }
}

async function listRuns(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      agent: { type: "string" },
      limit: { type: "string" },
      status: { type: "string" },
    },
  });

  const limit = values.limit ? Number(values.limit) : 20;
  if (!Number.isInteger(limit) || limit <= 0) {
    fail(`--limit must be a positive integer, got "${values.limit}".`);
  }

  if (values.status && !RUN_STATUSES.includes(values.status as RunStatus)) {
    fail(`--status must be one of ${RUN_STATUSES.join(", ")}, got "${values.status}".`);
  }

  let agentId: string | undefined;
  if (values.agent) {
    const agent = await prisma.agent.findUnique({ where: { name: values.agent } });
    if (!agent) {
      fail(`unknown agent "${values.agent}".`);
    }
    agentId = agent!.id;
  }

  const runs = await prisma.run.findMany({
    where: {
      ...(agentId ? { agentId } : {}),
      ...(values.status ? { status: values.status as RunStatus } : {}),
    },
    include: { agent: true },
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  if (runs.length === 0) {
    console.log("no runs found.");
    return;
  }

  for (const r of runs) {
    const finished = r.finishedAt ? r.finishedAt.toISOString() : "-";
    console.log(
      `${r.id}  ${r.agent.name.padEnd(20)}  ${r.trigger.padEnd(9)}  ${r.status.padEnd(9)}  ` +
        `${String(r.tokensIn).padStart(6)} in / ${String(r.tokensOut).padStart(6)} out  ` +
        `$${Number(r.costUsd).toFixed(6)}  started ${r.startedAt.toISOString()}  finished ${finished}`,
    );
  }
}

async function scheduler(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { scope: { type: "string" } } });
  const scope = values.scope ?? "default";

  const llm = buildLlmProvider();
  const executor = new InProcessExecutor({ llm }, prisma);
  const reconciler = startReconciler({ db: prisma });
  const sched = startScheduler({ executor, db: prisma, scope });

  console.log(`reevo scheduler started (scope "${scope}"). Press Ctrl+C to stop.`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log("\nreevo scheduler shutting down...");
      sched.stop();
      reconciler.stop();
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  try {
    if (command === "agent" && rest[0] === "create") {
      await agentCreate(rest.slice(1));
    } else if (command === "agent" && rest[0] === "schedule") {
      await agentSchedule(rest.slice(1));
    } else if (command === "run") {
      await run(rest[0]);
    } else if (command === "runs") {
      await listRuns(rest);
    } else if (command === "scheduler") {
      await scheduler(rest);
    } else {
      fail(
        "usage:\n" +
          "  reevo agent create --name <n> --model <m> --prompt <p> --budget <usd> [--schedule \"<cron>\"] [--timezone <tz>]\n" +
          '  reevo agent schedule <name> --cron "<expr>" [--timezone <tz>] [--disable]\n' +
          "  reevo run <name>\n" +
          "  reevo runs [--agent <name>] [--limit N] [--status <s>]\n" +
          "  reevo scheduler [--scope default]",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
