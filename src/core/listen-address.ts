/** A listener's bind address, from a `host:port` or `:port` environment variable. */
export interface ListenAddress {
  host: string;
  port: number;
}

/**
 * Parses a listen variable (`host:port`, or `:port` for every interface); unset or blank =
 * undefined. Anything else throws, naming the variable.
 */
export function parseListenAddress(variable: string, value: string | undefined): ListenAddress | undefined {
  if (!value?.trim()) return undefined;
  const match = /^(.*):(\d{1,5})$/.exec(value.trim());
  const port = match ? Number(match[2]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variable} must be host:port or :port (got "${value}").`);
  }
  return { host: match[1] || "0.0.0.0", port };
}
