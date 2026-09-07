const { mkdirSync } = require("node:fs");

for (const name of ["workspace", "git", "input", "output"]) {
  mkdirSync(`/run/reevo/storage/${name}`, { recursive: true, mode: 0o700 });
}
process.stdout.write("reevo_storage_ready\n");
setInterval(() => undefined, 60_000);
