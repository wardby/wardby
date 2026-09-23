/**
 * The coding proxy's second listener: the *deny port*.
 *
 * It exists only to be unreachable. No run's NetworkPolicy ever permits a
 * coding-run pod to reach it, so a run pod that can connect to the proxy on
 * CODING_PROXY_PORT but not on CODING_PROXY_DENY_PORT has proven its policy is
 * programmed and port-scoped — something no accident can produce, and the one
 * witness a cluster without kube-dns (GKE Autopilot, where Cloud DNS is the
 * only provider) still has.
 *
 * It must therefore serve nothing at all: the socket is never read
 * (`pauseOnConnect`), nothing is ever written to it, and it is destroyed the
 * moment it is accepted. There is no protocol here to attack and no credential
 * to leak — only the fact that the TCP handshake completed.
 */
import { createServer } from "node:net";

export interface DenyPortListenerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startDenyPortListener(host: string, port: number): Promise<DenyPortListenerHandle> {
  const server = createServer({ pauseOnConnect: true }, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    // Left registered after listen(): a later 'error' event on a net.Server with no listener
    // crashes the process, and rejecting an already-settled promise is a no-op.
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
