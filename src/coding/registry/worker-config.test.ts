import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "./token.js";
import { registryWorkerSetup } from "./worker-config.js";

describe("registryWorkerSetup", () => {
  it("configures every adapter with the token it is given, never the capability", () => {
    const setup = registryWorkerSetup({
      proxyBaseUrl: "http://wardby-proxy:8787",
      token: deriveRegistryToken("rrp_secret"),
      cacheRoot: "/workspace/.cache",
    });
    const token = deriveRegistryToken("rrp_secret");
    expect(token).toMatch(/^rrg_[A-Za-z0-9_-]{43}$/);
    expect(setup.env.npm_config_registry).toBe("http://wardby-proxy:8787/registry/npm/");
    expect(setup.env.PIP_INDEX_URL).toContain(token);
    expect(JSON.stringify(setup)).not.toContain("rrp_secret");
    expect(setup.files.every((file) => file.path.startsWith("/workspace/.cache/"))).toBe(true);
  });

  it("with deriveRegistryToken(capability) is byte-for-byte what it built from the capability before", () => {
    // Pinned from the output before registryWorkerSetup took the token instead of the capability.
    const capability = "rrp_FAKE_CAPABILITY_FOR_PINNING_ONLY_0000000";
    const token = "rrg_DxTSQDPFp5koQl4UlhkQb-Y9kD6mgvrwTc27OXclGLI";
    expect(deriveRegistryToken(capability)).toBe(token);
    const proxy = "http://wardby-proxy:8787";
    const pypi = `http://wardby:${token}@wardby-proxy:8787/registry/pypi/simple/`;
    expect(
      registryWorkerSetup({
        proxyBaseUrl: proxy,
        token: deriveRegistryToken(capability),
        cacheRoot: "/workspace/.cache",
      }),
    ).toStrictEqual({
      env: {
        npm_config_registry: `${proxy}/registry/npm/`,
        npm_config_userconfig: "/workspace/.cache/npm/npmrc",
        npm_config_ignore_scripts: "true",
        npm_config_cache: "/workspace/.cache/npm",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
        YARN_IGNORE_SCRIPTS: "true",
        YARN_NPM_REGISTRY_SERVER: `${proxy}/registry/npm`,
        YARN_NPM_AUTH_TOKEN: token,
        YARN_NPM_ALWAYS_AUTH: "true",
        YARN_UNSAFE_HTTP_WHITELIST: "wardby-proxy",
        YARN_ENABLE_TELEMETRY: "0",
        YARN_ENABLE_SCRIPTS: "false",
        YARN_GLOBAL_FOLDER: "/workspace/.cache/npm/yarn-berry",
        COREPACK_NPM_REGISTRY: `${proxy}/registry/npm`,
        COREPACK_NPM_TOKEN: token,
        COREPACK_HOME: "/workspace/.cache/npm/corepack",
        COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
        COREPACK_ENABLE_AUTO_PIN: "0",
        COREPACK_DEFAULT_TO_LATEST: "0",
        WARDBY_NPM_PLAN_REGISTRY: `${proxy}/registry/npm/`,
        PIP_INDEX_URL: pypi,
        PIP_TRUSTED_HOST: "wardby-proxy",
        POETRY_CACHE_DIR: "/workspace/.cache/pypi/poetry",
        POETRY_NO_INTERACTION: "1",
        POETRY_VIRTUALENVS_IN_PROJECT: "true",
        UV_NO_PROGRESS: "1",
        PIP_ONLY_BINARY: ":all:",
        PIP_CACHE_DIR: "/workspace/.cache/pypi",
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PIP_NO_INPUT: "1",
        UV_DEFAULT_INDEX: pypi,
        UV_NO_BUILD: "1",
        UV_CACHE_DIR: "/workspace/.cache/pypi/uv",
        UV_PYTHON_DOWNLOADS: "never",
      },
      files: [
        {
          path: "/workspace/.cache/npm/npmrc",
          content: `//wardby-proxy:8787/registry/npm/:_authToken=${token}\n`,
          mode: 0o600,
        },
      ],
    });
  });
});
