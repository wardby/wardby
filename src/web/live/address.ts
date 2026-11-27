/**
 * The address other replicas reach this one at for live co-editing (the "advertise address", written into the
 * leases it holds): WARDBY_LIVE_ADVERTISE_ADDRESS when set (host:port), otherwise this machine's first
 * non-internal IPv4 address with the HTTP port (the pod IP in Kubernetes, the container's address in Docker
 * Compose). Set the variable where that guess is wrong: separate machines with several networks or NAT.
 */
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

const HOST_PORT = /^(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]{1,253}):[1-9][0-9]{0,4}$/;

export function liveAdvertiseAddress(
  bind: { host: string; port: number },
  env: NodeJS.ProcessEnv = process.env,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string {
  const set = env.WARDBY_LIVE_ADVERTISE_ADDRESS?.trim();
  if (set) {
    if (!HOST_PORT.test(set) || Number(set.slice(set.lastIndexOf(":") + 1)) > 65535) {
      throw new Error(`WARDBY_LIVE_ADVERTISE_ADDRESS must be host:port (got "${set}").`);
    }
    return set;
  }
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.family === "IPv4" && !i.internal) return `${i.address}:${bind.port}`;
    }
  }
  return `${bind.host}:${bind.port}`;
}
