// The GKE control plane runs native runs on the durable DBOS executor, pinned
// to a per-deploy application version that up.sh substitutes, and the migration
// Job creates DBOS's schema before the control plane starts. Other targets keep
// the code default (in-process): nothing outside this overlay sets EXECUTOR.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllYaml } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../../..");
const read = (file) => readFileSync(join(here, file), "utf8");
const load = (file) => loadAllYaml(read(file));

const controlPlane = load("control-plane.yaml").find((o) => o.kind === "Deployment");
const env = Object.fromEntries(controlPlane.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
const upSh = readFileSync(join(root, "deploy/gke/up.sh"), "utf8");
const PLACEHOLDER = "wardby-dbos-app-version";

describe("GKE control plane executor", () => {
  it("runs native runs on the durable DBOS executor", () => {
    expect(env.EXECUTOR).toBe("dbos");
  });

  it("leaves the executor id to the process, and the schema to the default the grants name", () => {
    // A replacement pod adopts a dead pod's workflows through the reconciler
    // whatever its id (DbosExecutor.recover), so a random id per process is
    // correct, and a fixed one would be shared by `kubectl exec ... mcp`.
    expect(env).not.toHaveProperty("DBOS_EXECUTOR_ID");
    // deploy/gke/database-grants.sql grants on schema "dbos", the default.
    expect(env).not.toHaveProperty("DBOS_SCHEMA");
    expect(env).not.toHaveProperty("DBOS_SYSTEM_DATABASE_URL");
  });

  it("pins DBOS__APPVERSION to a placeholder up.sh substitutes", () => {
    expect(env.DBOS__APPVERSION).toBe(PLACEHOLDER);
  });

  it("sets EXECUTOR nowhere else in the kind-coding manifests", () => {
    for (const dir of [join(here, "../../base"), join(here, "../kind")]) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
        expect(readFileSync(join(dir, file), "utf8"), `${dir}/${file}`).not.toMatch(/EXECUTOR/);
      }
    }
  });
});

describe("up.sh DBOS__APPVERSION substitution", () => {
  // The sed expression up.sh applies to the rendered overlay, run as written.
  const expr = upSh.split("\n").find((line) => line.includes(`s|value: ${PLACEHOLDER}|`));

  it("substitutes the runtime image digest", () => {
    expect(expr).toBeDefined();
    const sedArg = expr
      .trim()
      .replace(/^-e\s+/, "")
      .replace(/\s*\\$/, "");
    const out = execFileSync("bash", ["-c", `sed -e ${sedArg} "$FILE"`], {
      env: {
        PATH: process.env.PATH,
        FILE: join(here, "control-plane.yaml"),
        RUNTIME_IMAGE: `registry.example/runtime@sha256:${"a".repeat(64)}`,
      },
    }).toString();
    expect(out).not.toContain(PLACEHOLDER);
    const rendered = loadAllYaml(out).find((o) => o.kind === "Deployment");
    const version = rendered.spec.template.spec.containers[0].env.find((e) => e.name === "DBOS__APPVERSION").value;
    expect(version).toBe(`sha256:${"a".repeat(64)}`);
  });

  it("refuses to apply a manifest that still carries the placeholder", () => {
    const fn = upSh.match(/^assert_no_placeholders\(\) \{[\s\S]*?^\}$/m)?.[0];
    expect(fn).toBeDefined();
    const run = (manifest) =>
      execFileSync("bash", ["-c", `${fn}\nassert_no_placeholders "$M"`], {
        env: { PATH: process.env.PATH, M: manifest },
        stdio: "pipe",
      });
    expect(() => run(`value: ${PLACEHOLDER}`)).toThrow();
    expect(() => run(`value: "sha256:${"a".repeat(64)}"`)).not.toThrow();
  });
});

describe("GKE migration Job", () => {
  const job = load("migrate/job.yaml").find((o) => o.kind === "Job");
  const container = job.spec.template.spec.containers.find((c) => c.name === "migrate");

  it("migrates DBOS's schema as the migrator, after the Prisma migrations", () => {
    const command = container.command.join(" ");
    const prisma = command.indexOf("npm run prisma:migrate");
    const dbos = command.indexOf("npm run dbos:migrate");
    expect(prisma).toBeGreaterThanOrEqual(0);
    expect(dbos).toBeGreaterThan(prisma);
    // Stops at the first failure, so a failed Prisma migration never goes on.
    expect(command).toMatch(/&&/);
  });

  it("uses a package script that runs DBOS's own schema migration against DATABASE_URL", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts["dbos:migrate"]).toMatch(/^dbos schema "\$DATABASE_URL"$/);
  });
});
