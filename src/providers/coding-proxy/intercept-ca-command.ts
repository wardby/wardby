/**
 * `wardby coding intercept-ca (--host <host> ... | --unconstrained) --out <dir> [--days <n>]`: creates the CA the
 * coding proxy uses for TLS interception (see tunnel-ca.ts), as `ca.crt` and `ca.key` in `<dir>`. Run it once per
 * deployment and keep the key in a Secret mounted on the proxy only; give the certificate to the runs.
 *
 * Offline: no environment, database or server runtime. It never overwrites a file, writes the key readable by
 * its owner alone, and prints only paths: no key or certificate text reaches the terminal.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateInterceptCa, InterceptCaError } from "./tunnel-ca.js";

const USAGE =
  "usage: wardby coding intercept-ca (--host <host> [--host <host> ...] | --unconstrained) --out <dir> [--days <n>]";

export async function interceptCaCommand(
  args: string[],
  write: (text: string) => void = (text) => void process.stdout.write(text),
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>;
  try {
    parsed = parseArgs({ args, options: OPTIONS });
  } catch {
    write(`${USAGE}\n`);
    return 2;
  }
  const { host: hosts = [], out, days, unconstrained = false } = parsed.values;
  if (!out || (unconstrained ? hosts.length > 0 : hosts.length === 0)) {
    write(`${USAGE}\n`);
    return 2;
  }
  const validityDays = days === undefined ? undefined : /^\d+$/.test(days) ? Number(days) : NaN;
  try {
    const ca = await generateInterceptCa({
      hosts,
      unconstrained,
      ...(validityDays === undefined ? {} : { validityDays }),
    });
    const directory = resolve(out);
    const certFile = join(directory, "ca.crt");
    const keyFile = join(directory, "ca.key");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // "wx": an existing file is an error, so a CA already in use is never replaced by accident.
    await writeFile(keyFile, ca.privateKeyPem, { flag: "wx", mode: 0o600 });
    await writeFile(certFile, ca.certificatePem, { flag: "wx", mode: 0o644 });
    write(`Wrote ${certFile} (public) and ${keyFile} (private: keep it in a Secret on the proxy only).\n`);
    if (unconstrained) write("warning: this CA has no name constraint; its key can sign for any host.\n");
    return 0;
  } catch (error) {
    if (error instanceof InterceptCaError) write(`error: ${error.message}\n`);
    else if ((error as NodeJS.ErrnoException).code === "EEXIST")
      write("error: ca.crt or ca.key already exists; nothing was overwritten.\n");
    else write("error: the CA could not be written.\n");
    return 1;
  }
}

const OPTIONS = {
  host: { type: "string", multiple: true },
  unconstrained: { type: "boolean" },
  out: { type: "string" },
  days: { type: "string" },
} as const;
