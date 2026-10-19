// Types for uv-lock.mjs, so its tests are type-checked.
export interface ProxyUrls {
  index: string;
  files: string;
}

export declare const PROJECT_COMMANDS: ReadonlySet<string>;
export declare function positionals(args: readonly string[]): string[];
export declare function planTargets(
  args: readonly string[],
  cwd?: string,
): { requirements?: string[]; lock?: string | { missing: string } };
export declare function proxyUrls(env?: Record<string, string | undefined>): ProxyUrls | undefined;
export declare function publicFileUrl(name: string, filename: string): string | undefined;
export declare function routeLock(text: string, proxy: ProxyUrls): { text: string; originals: Map<string, string> };
export declare function unrouteLock(text: string, proxy: ProxyUrls, originals?: Map<string, string>): string;
