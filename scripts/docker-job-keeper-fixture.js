const { mkdirSync } = require("node:fs");

for (const name of ["workspace", "git", "input", "output"]) {
  mkdirSync(`/run/wardby/storage/${name}`, { recursive: true, mode: 0o700 });
}
process.stdout.write("wardby_storage_ready\n");
setInterval(() => undefined, 60_000);
