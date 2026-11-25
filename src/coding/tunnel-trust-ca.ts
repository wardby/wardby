/**
 * The CA certificate the coding proxy signs TLS interception with (docs/coding-proxy-tunnel.md), as the
 * control plane hands it to each run so the run's tools trust it. Public material only: a file that holds
 * anything but certificate blocks (a private key included) is refused, and an error never carries the
 * file's text or path.
 */
import { readFileSync } from "node:fs";

/** The tool runner's per-file limit (CLAUDE_TOOL_SETUP_LIMITS.maxFileBytes): the certificate travels in its setup. */
export const MAX_TUNNEL_CA_BYTES = 16 * 1024;

const BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+?\r?\n-----END CERTIFICATE-----/g;

/** The certificate blocks of a PEM text, normalized to LF line ends and one trailing newline. */
export function parseTunnelCaCert(text: string): string {
  const trimmed = text.trim();
  const blocks = trimmed.match(BLOCK) ?? [];
  if (
    blocks.length === 0 ||
    trimmed.replace(BLOCK, "").trim() !== "" ||
    Buffer.byteLength(trimmed) > MAX_TUNNEL_CA_BYTES
  ) {
    throw new Error("tunnel_ca_invalid");
  }
  return `${blocks.map((block) => block.replace(/\r\n/g, "\n")).join("\n")}\n`;
}

/** Read at start-up, where the control plane is composed, so a bad file stops it there and not at a run. */
export function readTunnelCaCert(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error("tunnel_ca_unreadable");
  }
  return parseTunnelCaCert(text);
}

/**
 * The certificate in `file` as each run is launched: read at start-up (throwing as `readTunnelCaCert` does),
 * then again on every call, so a rotated CA (a cert-manager Secret mounted as a volume) reaches the next run
 * without a restart. A read that fails keeps the last good certificate; `onError` gets the fixed code only.
 */
export function tunnelCaCertSource(file: string, onError?: (code: string) => void): () => string {
  let current = readTunnelCaCert(file);
  return () => {
    try {
      current = readTunnelCaCert(file);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : "tunnel_ca_unreadable");
    }
    return current;
  };
}
