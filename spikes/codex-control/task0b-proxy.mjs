#!/usr/bin/env node
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { actualCostUsd, completedUsageFromSseFrame, estimateReservationUsd } from "./task0b-metering.mjs";

const listenPort = Number(process.env.PORT ?? 8080);
const capability = required("REEVO_RUN_CAPABILITY");
const model = process.env.REEVO_MODEL ?? "gpt-5.6-luna";
const maxOutputTokens = Number(process.env.REEVO_MAX_OUTPUT_TOKENS ?? 128);
const absoluteMaxUsd = Number(process.env.REEVO_ABSOLUTE_MAX_USD ?? 0.02);
const evidencePath = process.env.REEVO_EVIDENCE_PATH ?? "/evidence/task0b-usage.jsonl";
const key = (await readFile(process.env.OPENAI_API_KEY_FILE ?? "/run/secrets/openai_api_key", "utf8")).trim();

if (!key) throw new Error("OpenAI API key file is empty");
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 128) {
  throw new Error("REEVO_MAX_OUTPUT_TOKENS must be an integer from 1 through 128");
}
if (!Number.isFinite(absoluteMaxUsd) || absoluteMaxUsd <= 0 || absoluteMaxUsd > 0.02) {
  throw new Error("REEVO_ABSOLUTE_MAX_USD must be greater than zero and at most 0.02");
}

const state = {
  phase: "calibrate",
  budgetUsd: 0,
  spentUsd: 0,
  proxyRequests: 0,
  upstreamResponses: 0,
  persistedResponses: 0,
  rejectedRequests: 0,
};

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function persist(record) {
  await mkdir(dirname(evidencePath), { recursive: true });
  const handle = await open(evidencePath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function rejectBudget(response, reservationUsd, reason = "run budget exhausted") {
  state.rejectedRequests += 1;
  await persist({
    type: "request.rejected",
    at: new Date().toISOString(),
    reason,
    spentUsd: state.spentUsd,
    budgetUsd: state.budgetUsd,
    reservationUsd,
  });
  json(response, 429, { error: { message: reason, type: "reevo_budget_exhausted" } });
}

async function forward(body, response, reservationUsd) {
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const errorBody = (await upstream.text()).slice(0, 2_000);
    json(response, upstream.status, { error: { message: `upstream rejected request: ${errorBody}` } });
    return;
  }

  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
    "cache-control": "no-cache",
  });

  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const usage = completedUsageFromSseFrame(frame);
      if (!usage) {
        response.write(`${frame}\n\n`);
        continue;
      }

      const costUsd = actualCostUsd(usage);
      const nextSpent = state.spentUsd + costUsd;
      await persist({
        type: "response.completed",
        at: new Date().toISOString(),
        model,
        usage,
        costUsd,
        reservationUsd,
        spentUsd: nextSpent,
        budgetUsd: state.budgetUsd,
      });
      state.spentUsd = nextSpent;
      state.upstreamResponses += 1;
      state.persistedResponses += 1;
      completed = true;
      response.write(`${frame}\n\n`);
    }
  }

  if (buffer) response.write(buffer);
  if (!completed) {
    response.destroy(new Error("upstream stream ended without response.completed usage"));
    return;
  }
  response.end();
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && request.url === "/status") {
      if (request.headers.authorization !== `Bearer ${capability}`) {
        json(response, 401, { error: { message: "missing capability" } });
        return;
      }
      json(response, 200, { ...state });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      json(response, 404, { error: { message: "not found" } });
      return;
    }
    if (request.headers.authorization !== `Bearer ${capability}`) {
      json(response, 401, { error: { message: "missing capability" } });
      return;
    }

    state.proxyRequests += 1;
    const body = await readJson(request);
    body.model = model;
    body.max_output_tokens = maxOutputTokens;
    body.store = false;
    body.tools = [];
    body.tool_choice = "none";
    body.reasoning = { effort: "none" };
    const reservationUsd = estimateReservationUsd(body);

    if (state.phase === "calibrate") {
      state.budgetUsd = absoluteMaxUsd;
      if (reservationUsd + 0.000001 > absoluteMaxUsd) {
        state.phase = "stopped";
        await rejectBudget(response, reservationUsd, "calibrated request exceeds absolute spend ceiling");
        return;
      }
      state.phase = "live";
      state.budgetUsd = reservationUsd + 0.000001;
      await persist({
        type: "calibration.completed",
        at: new Date().toISOString(),
        model,
        reservationUsd,
        budgetUsd: state.budgetUsd,
      });
      await rejectBudget(response, reservationUsd, "calibration request intentionally blocked");
      return;
    }

    if (state.phase !== "live") {
      await rejectBudget(response, reservationUsd, "proxy is stopped");
      return;
    }

    if (state.spentUsd + reservationUsd > state.budgetUsd) {
      await rejectBudget(response, reservationUsd);
      return;
    }
    await forward(body, response, reservationUsd);
  } catch (error) {
    json(response, 500, { error: { message: error instanceof Error ? error.message : "proxy failure" } });
  }
});

await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(`${evidencePath}.ready`, `${new Date().toISOString()}\n`, { mode: 0o600 });
server.listen(listenPort, "0.0.0.0");

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
