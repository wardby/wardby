#!/usr/bin/env node
// Seeds Google Secret Manager with the GKE deployment's secrets.
//
// Terraform creates the secrets empty (secrets.tf); this fills them, so no value
// ever passes through Terraform or lands in its state. Run by up.sh.
//
// For each secret: an existing version is left alone -- Secret Manager is the
// source of truth once seeded. An empty secret is filled from, in order, the live
// cluster's wardby-control-plane-env Secret (so today's SECRET_APP_KEY and auth
// keys carry over), .env.local, or -- for the two auth keys only -- a new random
// key. An optional group (Jira, Slack, Gemini) is seeded only when every one of its
// values has a source, and left empty when none does; anything in between is
// an error.
//
// Values travel over stdin and stdout only, never in a process argument, and are
// never printed. Every decision is made before anything is written, so a missing
// value stops the run with nothing half-seeded.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SECRETS = [
  { id: "openai-api-key", env: "OPENAI_API_KEY", source: "carry" },
  { id: "anthropic-api-key", env: "ANTHROPIC_API_KEY", source: "carry" },
  { id: "secret-app-key", env: "SECRET_APP_KEY", source: "carry" },
  { id: "github-app-id", env: "GITHUB_APP_ID", source: "carry" },
  { id: "github-app-private-key", env: "GITHUB_APP_PRIVATE_KEY", source: "carry" },
  { id: "github-app-webhook-secret", env: "GITHUB_APP_WEBHOOK_SECRET", source: "carry-or-generate" },
  // The App's OAuth client credentials, for link_host_account (GitHub account
  // linking). Created in the App's settings, never generated here.
  { id: "github-app-client-id", env: "GITHUB_APP_CLIENT_ID", source: "carry" },
  { id: "github-app-client-secret", env: "GITHUB_APP_CLIENT_SECRET", source: "carry" },
  { id: "auth-signing-key", env: "AUTH_SIGNING_KEY", source: "carry-or-generate" },
  { id: "auth-credential-hash-key", env: "AUTH_CREDENTIAL_HASH_KEY", source: "carry-or-generate" },
  // Jira Cloud (docs/jira-agents.md). Optional, all or none: an operator who
  // doesn't use Jira leaves these empty, and up.sh then skips the
  // wardby-jira-env ExternalSecret. The expiry date is in the group because
  // every service account token has one.
  { id: "jira-site-url", env: "WARDBY_JIRA_SITE_URL", source: "optional", group: "jira" },
  { id: "jira-api-base-url", env: "WARDBY_JIRA_API_BASE_URL", source: "optional", group: "jira" },
  { id: "jira-api-token", env: "WARDBY_JIRA_API_TOKEN", source: "optional", group: "jira" },
  { id: "jira-api-token-expires-at", env: "WARDBY_JIRA_API_TOKEN_EXPIRES_AT", source: "optional", group: "jira" },
  { id: "jira-webhook-secret", env: "WARDBY_JIRA_WEBHOOK_SECRET", source: "optional", group: "jira" },
  // Slack workflow notifications (docs/slack-notifications.md). Optional: an
  // operator who doesn't post to Slack leaves it empty, and up.sh then skips
  // the wardby-slack-env ExternalSecret. WARDBY_SLACK_CUSTOMIZE and
  // WARDBY_SLACK_API_BASE_URL are not secrets and are not seeded.
  { id: "slack-bot-token", env: "WARDBY_SLACK_BOT_TOKEN", source: "optional", group: "slack" },
  // Google AI Studio (Gemini) native models (docs/models.md). Optional: synced
  // only when set, through the wardby-gemini-env ExternalSecret.
  { id: "gemini-api-key", env: "GEMINI_API_KEY", source: "optional", group: "gemini" },
];

const CONTROL_PLANE_SECRET = "wardby-control-plane-env";

export function generateHexKey() {
  return randomBytes(32).toString("hex");
}

// hasVersion counts enabled versions only, so a secret whose versions are all
// disabled or destroyed counts as empty: with no cluster or .env.local source,
// an auth key would then be regenerated (logged "from generated").
export function decideSeed(entry, state) {
  if (state.hasVersion) return { action: "keep" };
  if (state.cluster) return { action: "add", from: "cluster", value: state.cluster };
  if (state.env) return { action: "add", from: ".env.local", value: state.env };
  if (entry.source === "carry-or-generate") return { action: "add", from: "generated", value: state.generate() };
  if (entry.source === "optional") return { action: "skip" };
  return {
    action: "error",
    message: `${entry.id}: no value in Secret Manager, the cluster, or .env.local (${entry.env})`,
  };
}

function execCommand(cmd, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

async function must(exec, cmd, args, options) {
  const result = await exec(cmd, args, options);
  // stderr is safe to show: every command here receives secrets on stdin only.
  if (result.code !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function clusterValues(exec, { context, namespace }) {
  const result = await exec("kubectl", [
    "--context",
    context,
    "-n",
    namespace,
    "get",
    "secret",
    CONTROL_PLANE_SECRET,
    "-o",
    "json",
  ]);
  if (result.code !== 0) {
    if (result.stderr.includes("NotFound")) return {};
    throw new Error(`kubectl get secret ${CONTROL_PLANE_SECRET} failed: ${result.stderr.trim()}`);
  }
  const data = JSON.parse(result.stdout).data ?? {};
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]));
}

export async function seed({
  project,
  prefix,
  context,
  namespace,
  env,
  exec = execCommand,
  generate = generateHexKey,
  log = console.log,
}) {
  const cluster = await clusterValues(exec, { context, namespace });

  const plan = [];
  for (const entry of SECRETS) {
    const name = `${prefix}-${entry.id}`;
    const listed = await must(exec, "gcloud", [
      "secrets",
      "versions",
      "list",
      name,
      `--project=${project}`,
      "--filter=state:enabled",
      "--limit=1",
      "--format=value(name)",
    ]);
    const hasVersion = listed.trim() !== "";
    const decision = decideSeed(entry, {
      hasVersion,
      cluster: cluster[entry.env],
      env: env[entry.env],
      generate,
    });
    plan.push({ entry, name, decision });
  }

  const errors = plan.filter((p) => p.decision.action === "error").map((p) => p.decision.message);
  const enabledGroups = [];
  for (const group of new Set(SECRETS.map((s) => s.group).filter(Boolean))) {
    const members = plan.filter((p) => p.entry.group === group);
    const missing = members.filter((p) => p.decision.action === "skip");
    if (missing.length === 0) enabledGroups.push(group);
    else if (missing.length < members.length) {
      errors.push(
        `${group}: set all of ${members.map((p) => p.entry.env).join(", ")} or none of them ` +
          `(no value for ${missing.map((p) => p.entry.env).join(", ")})`,
      );
    }
  }
  if (errors.length > 0) throw new Error(`nothing was written:\n  ${errors.join("\n  ")}`);

  for (const { name, decision } of plan) {
    if (decision.action === "skip") {
      log(`left ${name} empty (optional)`);
      continue;
    }
    if (decision.action === "keep") {
      log(`kept ${name}`);
      continue;
    }
    await must(exec, "gcloud", ["secrets", "versions", "add", name, `--project=${project}`, "--data-file=-"], {
      input: decision.value,
    });
    log(`added ${name} (from ${decision.from})`);
  }
  return { enabledGroups };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) options[argv[i].replace(/^--/, "")] = argv[i + 1];
  for (const key of ["project", "prefix", "context", "namespace"]) {
    if (!options[key]) throw new Error(`seed-secrets: --${key} is required`);
  }
  return options;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { default: dotenvFlow } = await import("dotenv-flow");
    // This dotenv-flow version has no `processEnv` config option, so
    // `.config()` would merge .env.local straight into process.env -- an
    // operator's shell OPENAI_API_KEY could then be mistaken for a source.
    // parse()+listFiles() reads the files without touching process.env.
    const env = dotenvFlow.parse(dotenvFlow.listFiles({}));
    const { enabledGroups } = await seed({
      project: options.project,
      prefix: options.prefix,
      context: options.context,
      namespace: options.namespace,
      env,
    });
    // up.sh reads this to decide which optional ExternalSecrets to apply.
    if (options["groups-out"]) writeFileSync(options["groups-out"], enabledGroups.map((g) => `${g}\n`).join(""));
  } catch (error) {
    console.error(`seed-secrets: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
