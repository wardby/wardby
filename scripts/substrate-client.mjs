// Downloads Substrate's public API definition from its pinned release at build time and
// generates a TypeScript client into the git-ignored src/generated/substrate/. Nothing of
// Substrate's is committed to this repository (CLEANROOM.md). The step is skipped when the
// generated output already carries a marker recording the same pinned digest, so installs and
// repeat builds need no network.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// v1.0.0 (tag object fd67f62...) dereferenced to its commit.
const COMMIT = "b34fbee742906494b5eb4f1f36987176bf8770a4";
const SHA256 = "b5bb348f04b8f8d9f24c4c880e1f4176771e1556cfd0cff95a97ca8bee079722";
const OUT = "src/generated/substrate";
const MARKER = `${OUT}/.proto-sha256`;
const URL_ = `https://raw.githubusercontent.com/agent-substrate/substrate/${COMMIT}/api/ateapi/v1/ateapi.proto`;
const dir = "build/substrate-proto/substrate/ateapi/v1";

const readMarker = () => {
  try {
    return readFileSync(MARKER, "utf8").trim();
  } catch {
    return undefined;
  }
};
if (readMarker() === SHA256) {
  console.log("substrate client up to date");
  process.exit(0);
}

const res = await fetch(URL_);
if (!res.ok) throw new Error(`substrate_proto_fetch_failed: HTTP ${res.status}`);
const body = Buffer.from(await res.arrayBuffer());
const digest = createHash("sha256").update(body).digest("hex");
if (digest !== SHA256) throw new Error(`substrate_proto_digest_mismatch: got ${digest}`);
await rm("build/substrate-proto", { recursive: true, force: true });
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/ateapi.proto`, body);
await rm(OUT, { recursive: true, force: true });
execFileSync("npx", ["buf", "generate", "build/substrate-proto", "--template", "scripts/buf.gen.substrate.yaml"], {
  stdio: "inherit",
});
await writeFile(MARKER, `${SHA256}\n`);
console.log("substrate client generated");
