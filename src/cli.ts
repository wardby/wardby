#!/usr/bin/env node
/**
 * Minimal CLI — the only entrypoint in Phase 1.
 *
 *   reevo agent create --name <n> --model <m> --prompt <p> --budget <usd>
 *   reevo run <name>
 */

import { parseArgs } from "node:util";
import { loadProviderConfig } from "./config/providers.js";
import { OpenAiLlmProvider } from "./providers/llm/index.js";
import type { ProviderRegistry } from "./providers/index.js";
import { prisma } from "./core/db.js";
import { runAgent } from "./core/runner.js";

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function buildLlmProvider(): ProviderRegistry["llm"] {
  const config = loadProviderConfig();
  if (config.llm !== "openai") {
    fail(`LLM_PROVIDER "${config.llm}" has no adapter in Phase 1 (only "openai").`);
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
    },
  });

  if (!values.name || !values.model || !values.prompt || !values.budget) {
    fail(
      "agent create requires --name, --model, --prompt, and --budget.",
    );
  }

  const budgetUsd = Number(values.budget);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    fail(`--budget must be a positive number, got "${values.budget}".`);
  }

  const agent = await prisma.agent.create({
    data: {
      name: values.name!,
      model: values.model!,
      systemPrompt: values.prompt!,
      budgetUsd,
    },
  });
  console.log(agent.id);
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  try {
    if (command === "agent" && rest[0] === "create") {
      await agentCreate(rest.slice(1));
    } else if (command === "run") {
      await run(rest[0]);
    } else {
      fail(
        "usage:\n" +
          "  reevo agent create --name <n> --model <m> --prompt <p> --budget <usd>\n" +
          "  reevo run <name>",
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
