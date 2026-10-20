// Types for pypi-plan.mjs, so its tests are type-checked.
import type { RegistryAccess } from "./registry-refusals.mjs";

export declare function planPythonLockfile(
  file: string,
  access: RegistryAccess | undefined,
  env?: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<string[]>;
