/**
 * KubernetesApi over @kubernetes/client-node 2.x. A thin mapping: each seam
 * method is one client call plus HTTP-status translation into the seam's
 * error classes. Proven against a real cluster by kubernetes.integration.test.ts.
 */
import {
  ApiException,
  CoreV1Api,
  Exec,
  KubeConfig,
  NetworkingV1Api,
  type V1ConfigMap,
  type V1NetworkPolicy,
  type V1Pod,
  type V1Secret,
  type V1Service,
  type V1Status,
} from "@kubernetes/client-node";
import { Writable } from "node:stream";
import {
  KubernetesAlreadyExistsError,
  KubernetesConflictError,
  KubernetesNotFoundError,
  type KubernetesApi,
  type KubernetesExecOptions,
} from "./kubernetes-api.js";

export interface ClientNodeKubernetesApiOptions {
  /** kubeconfig context to use; defaults to the current context (or in-cluster credentials). */
  context?: string;
}

function statusCode(error: unknown): number | undefined {
  return error instanceof ApiException ? (error as ApiException<unknown>).code : undefined;
}

/** Undefined for a 404; rethrows anything else. */
async function readOrUndefined<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (statusCode(error) === 404) return undefined;
    throw error;
  }
}

/** Swallows a 404 so deletes are idempotent. */
async function deleteIgnoringMissing(remove: () => Promise<unknown>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    if (statusCode(error) === 404) return;
    throw error;
  }
}

async function create<T>(what: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const code = statusCode(error);
    if (code === 409) throw new KubernetesAlreadyExistsError(what);
    if (code === 404) throw new KubernetesNotFoundError(what);
    throw error;
  }
}

async function replace<T>(what: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const code = statusCode(error);
    if (code === 409) throw new KubernetesConflictError(what);
    if (code === 404) throw new KubernetesNotFoundError(what);
    throw error;
  }
}

/** Exit code from the exec status channel: "Success" is 0, else the ExitCode cause, else 1. */
function exitCodeFromStatus(status: V1Status): number {
  if (status.status === "Success") return 0;
  const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
  const parsed = cause?.message === undefined ? Number.NaN : Number.parseInt(cause.message, 10);
  return Number.isInteger(parsed) ? parsed : 1;
}

/**
 * The slice of the exec WebSocket this adapter touches. client-node types it via
 * isomorphic-ws, whose typings are not installed; in Node it is a `ws` WebSocket.
 */
interface ExecSocket {
  close(): void;
  addEventListener(type: "close", listener: () => void): void;
}

export class ClientNodeKubernetesApi implements KubernetesApi {
  private readonly config: KubeConfig;
  private readonly core: CoreV1Api;
  private readonly networking: NetworkingV1Api;

  constructor(options: ClientNodeKubernetesApiOptions = {}) {
    this.config = new KubeConfig();
    this.config.loadFromDefault();
    if (options.context) this.config.setCurrentContext(options.context);
    this.core = this.config.makeApiClient(CoreV1Api);
    this.networking = this.config.makeApiClient(NetworkingV1Api);
  }

  createConfigMap(namespace: string, body: V1ConfigMap): Promise<V1ConfigMap> {
    return create(`configmap/${namespace}/${body.metadata?.name}`, () =>
      this.core.createNamespacedConfigMap({ namespace, body }),
    );
  }

  readConfigMap(namespace: string, name: string): Promise<V1ConfigMap | undefined> {
    return readOrUndefined(() => this.core.readNamespacedConfigMap({ namespace, name }));
  }

  replaceConfigMap(namespace: string, name: string, body: V1ConfigMap): Promise<V1ConfigMap> {
    return replace(`configmap/${namespace}/${name}`, () =>
      this.core.replaceNamespacedConfigMap({ namespace, name, body }),
    );
  }

  createSecret(namespace: string, body: V1Secret): Promise<V1Secret> {
    return create(`secret/${namespace}/${body.metadata?.name}`, () =>
      this.core.createNamespacedSecret({ namespace, body }),
    );
  }

  deleteSecret(namespace: string, name: string): Promise<void> {
    return deleteIgnoringMissing(() => this.core.deleteNamespacedSecret({ namespace, name }));
  }

  createPod(namespace: string, body: V1Pod): Promise<V1Pod> {
    return create(`pod/${namespace}/${body.metadata?.name}`, () => this.core.createNamespacedPod({ namespace, body }));
  }

  readPod(namespace: string, name: string): Promise<V1Pod | undefined> {
    return readOrUndefined(() => this.core.readNamespacedPod({ namespace, name }));
  }

  deletePod(namespace: string, name: string, gracePeriodSeconds: number): Promise<void> {
    return deleteIgnoringMissing(() => this.core.deleteNamespacedPod({ namespace, name, gracePeriodSeconds }));
  }

  createNetworkPolicy(namespace: string, body: V1NetworkPolicy): Promise<V1NetworkPolicy> {
    return create(`networkpolicy/${namespace}/${body.metadata?.name}`, () =>
      this.networking.createNamespacedNetworkPolicy({ namespace, body }),
    );
  }

  readNetworkPolicy(namespace: string, name: string): Promise<V1NetworkPolicy | undefined> {
    return readOrUndefined(() => this.networking.readNamespacedNetworkPolicy({ namespace, name }));
  }

  deleteNetworkPolicy(namespace: string, name: string): Promise<void> {
    return deleteIgnoringMissing(() => this.networking.deleteNamespacedNetworkPolicy({ namespace, name }));
  }

  readService(namespace: string, name: string): Promise<V1Service | undefined> {
    return readOrUndefined(() => this.core.readNamespacedService({ namespace, name }));
  }

  async readNamespace(name: string): Promise<boolean> {
    return (await readOrUndefined(() => this.core.readNamespace({ name }))) !== undefined;
  }

  exec(
    namespace: string,
    pod: string,
    container: string,
    command: string[],
    options: KubernetesExecOptions,
  ): Promise<number> {
    // stderr is requested but discarded so it never reaches wardby's logs.
    const stderr = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      let socket: ExecSocket | undefined;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error("kubernetes_exec_timeout")));
        socket?.close();
      }, options.timeoutMs);

      new Exec(this.config)
        .exec(
          namespace,
          pod,
          container,
          command,
          options.stdout ?? null,
          stderr,
          options.stdin ?? null,
          false,
          (status) => settle(() => resolve(exitCodeFromStatus(status))),
        )
        .then(
          (ws: unknown) => {
            socket = ws as ExecSocket;
            // Timed out while still connecting: close the late socket.
            if (settled) {
              socket.close();
              return;
            }
            // The status callback fires before the library closes the socket, so a close
            // that arrives first means the command's exit status was never reported.
            socket.addEventListener("close", () =>
              settle(() => reject(new Error("kubernetes_exec_closed_without_status"))),
            );
          },
          // A failed WebSocket handshake rejects with a ws ErrorEvent, not an Error.
          (error: unknown) =>
            settle(() =>
              reject(error instanceof Error ? error : new Error("kubernetes_exec_connect_failed", { cause: error })),
            ),
        );
    });
  }

  readLogTail(
    namespace: string,
    pod: string,
    container: string,
    tailLines: number,
    limitBytes: number,
  ): Promise<string> {
    return this.core.readNamespacedPodLog({ namespace, name: pod, container, tailLines, limitBytes });
  }
}
