/**
 * The paragraph dispatch adds to a coding agent's standing instructions when
 * its run has services (docs/coding-services.md): which services, the
 * variables each sets, and that they start empty; and, for a toolchain, that
 * the run's commands run in that image. The worker sees only its task text, so
 * this is how the builder learns the contract. A docker service adds how its
 * daemon must be used (host networking, no image pulls).
 */
import { DOCKER_TEST_ENV, type ResolvedDockerService, type ResolvedSidecarService } from "./catalog.js";

type NoteEntry =
  | (Pick<ResolvedSidecarService, "name" | "version" | "testEnv"> & { kind?: "sidecar" | "toolchain" })
  | Pick<ResolvedDockerService, "name" | "version" | "kind">;

/** How the agent must use a docker service's daemon: fixed text, no catalog value. */
export const DOCKER_SERVICE_NOTE = [
  "Docker: the `docker` CLI in your shell reaches a rootless Docker daemon for this run (DOCKER_HOST is set).",
  "Use host networking only: `docker build --network=host`, `docker run --network=host`, and `network_mode: host` in compose files; the default network has no DNS.",
  "Containers you start cannot reach the run's other services on 127.0.0.1.",
  "Images cannot be pulled from any registry, so build only images that need no base image pulled. Pushing images is not possible.",
].join(" ");

const variablesOf = (entry: NoteEntry): string =>
  Object.entries(entry.kind === "docker" ? DOCKER_TEST_ENV : entry.testEnv)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");

export function servicesInstructionNote(services: readonly NoteEntry[]): string | undefined {
  if (services.length === 0) return undefined;
  const toolchain = services.find((service) => service.kind === "toolchain");
  const sidecars = services.filter((service) => service.kind !== "toolchain");
  const lines: string[] = [];
  if (toolchain) {
    const variables = variablesOf(toolchain);
    lines.push(
      `Toolchain for this run: wardby runs your shell commands on this workspace in the \`${toolchain.name} ${toolchain.version}\` image, with its own interpreters, packages and settings. Use what it already has rather than installing another interpreter or rewriting its configuration.${variables ? ` It sets: ${variables}.` : ""}`,
    );
  }
  if (sidecars.length > 0) {
    lines.push(
      "Services for this run: wardby started these next to your workspace, reachable on 127.0.0.1. Each one starts empty; create any schema or data your tests need.",
      ...sidecars.map((service) => {
        const variables = variablesOf(service);
        return `- ${service.name} ${service.version}${variables ? `: ${variables}` : ""}`;
      }),
    );
  }
  if (sidecars.length > 0 || (toolchain && variablesOf(toolchain))) {
    lines.push(
      "These variables are already set in your shell environment; tests should read them instead of hard-coding connection details. Where two services set the same variable, the one listed first wins.",
    );
  }
  if (services.some((service) => service.kind === "docker")) lines.push(DOCKER_SERVICE_NOTE);
  return lines.join("\n");
}
