/**
 * The recorded Autopilot admission mutations, and the two pure functions that
 * produce and replay them.
 *
 * The fixture stores a *mutation list*, not a pair of whole pods, for two
 * reasons: a reviewer can read the entire set of differences the platform
 * introduces in a few lines, and the test rebuilds the submitted pod from the
 * live builder rather than replaying a stored one, so the fixture can never
 * carry a stale *pod*.
 *
 * That is a narrower guarantee than it sounds, and the difference matters.
 * Because the attestation test derives BOTH operands from the same builder, it
 * is structurally blind to a weakening of the builder itself: measured on this
 * branch, setting `automountServiceAccountToken: true` or halving the worker's
 * CPU leaves the whole suite green. Three other sabotages — dropping
 * `runtimeClassName`, dropping the pod `seccompProfile`, `hostPID: true` — do
 * fail it, but only incidentally: those exact fields appear in the "rejects one
 * more mutation" tamper list, so a builder that already emits the tampered
 * value turns that tamper into a no-op. That is luck, not coverage, and it is
 * not a property to rely on.
 *
 * What this file guards is that the *platform's* mutation set is still exactly
 * the set the profile forgives. The builder's own fields are guarded by
 * kubernetes-isolation.test.ts and kubernetes-platform.test.ts, and must stay
 * that way.
 *
 * `provisional` is true while the file is written from documentation rather
 * than captured from a cluster. The attestation suite names that state in its
 * report, so a forgotten capture cannot pass unnoticed.
 *
 * This is development data reviewed in a diff, never a runtime authority: the
 * launcher never asks a cluster what it is allowed to change.
 */
import { readFileSync } from "node:fs";
import type { KubernetesPlatform } from "./kubernetes-platform.js";

export interface PodMutation {
  op: "add" | "replace" | "remove";
  /** JSON Pointer (RFC 6901): "/" separated, with ~1 for "/" and ~0 for "~". */
  path: string;
  value?: unknown;
}

export interface DryRunFixture {
  capturedAt: string;
  platform: KubernetesPlatform;
  /** True until a real server-side dry run replaces this file. */
  provisional: boolean;
  source: string;
  notes: string[];
  mutations: PodMutation[];
}

const FIXTURE_URL = new URL("./fixtures/gke-autopilot-dry-run.json", import.meta.url);

export function loadDryRunFixture(): DryRunFixture {
  return JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as DryRunFixture;
}

function segments(path: string): string[] {
  if (path === "" || !path.startsWith("/")) throw new Error(`dry_run_fixture_path: ${path}`);
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

type Bag = Record<string, unknown> | unknown[];

function container(root: unknown, path: string[]): Bag {
  let node: unknown = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") throw new Error(`dry_run_fixture_path: /${path.join("/")}`);
    node = (node as Record<string, unknown>)[key];
  }
  if (node === null || typeof node !== "object") throw new Error(`dry_run_fixture_path: /${path.join("/")}`);
  return node as Bag;
}

/**
 * Returns a copy of `document` with every mutation applied in order.
 *
 * `add` and `replace` assign at the pointer. `remove` deletes an object key,
 * but SPLICES an array element: `delete array[2]` would leave a hole that
 * serializes back as `null`, which would then be deep-compared against a real
 * pod as a null list entry rather than as a removal. The differ only ever
 * replaces arrays wholesale, so an array pointer can reach here only from a
 * hand-written fixture entry — which is exactly when a silent `null` hole
 * would be hardest to spot in review.
 */
export function applyMutations<T>(document: T, mutations: readonly PodMutation[]): T {
  const copy = structuredClone(document);
  for (const mutation of mutations) {
    const path = segments(mutation.path);
    // `segments` always yields at least one element for a pointer starting with "/", so this
    // never throws in practice; it narrows the type without a non-null assertion.
    const key = path.pop();
    if (key === undefined) throw new Error(`dry_run_fixture_path: ${mutation.path}`);
    const parent = container(copy, path);
    if (Array.isArray(parent) && mutation.op === "remove") {
      const index = /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
      if (index < 0 || index >= parent.length) throw new Error(`dry_run_fixture_path: ${mutation.path}`);
      parent.splice(index, 1);
      continue;
    }
    const bag = parent as Record<string, unknown>;
    if (mutation.op === "remove") delete bag[key];
    else bag[key] = structuredClone(mutation.value);
  }
  return copy;
}

function escape(key: string): string {
  return key.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * The mutations that turn `before` into `after`. Objects are walked key by key;
 * anything else (including arrays) is replaced wholesale, which keeps a
 * toleration list or a container list readable as one op.
 *
 * Sorted by code point, not `localeCompare`: the result is committed to a file
 * and reviewed as a diff, so the order must not depend on the capturing
 * machine's locale (an ICU collation folds case together and orders
 * `/spec/Foo` and `/spec/foo` by tie-break rules that differ between hosts).
 */
export function diffMutations(before: unknown, after: unknown, prefix = ""): PodMutation[] {
  const plain = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!plain(before) || !plain(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ op: "replace", path: prefix, value: after }];
  }
  const left = before as Record<string, unknown>;
  const right = after as Record<string, unknown>;
  const mutations: PodMutation[] = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const path = `${prefix}/${escape(key)}`;
    if (!(key in right) || right[key] === undefined) {
      if (left[key] !== undefined) mutations.push({ op: "remove", path });
    } else if (!(key in left) || left[key] === undefined) {
      mutations.push({ op: "add", path, value: right[key] });
    } else {
      mutations.push(...diffMutations(left[key], right[key], path));
    }
  }
  return mutations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
