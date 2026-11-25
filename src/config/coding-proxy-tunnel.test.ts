import { describe, expect, it } from "vitest";
import { loadCodingTunnelConfig } from "./coding-proxy-tunnel.js";

const MIB = 1024 * 1024;

const valid = { CODING_TUNNEL_PORT: "8789", CODING_TUNNEL_ALLOWED_HOSTS: "registry.example.com" };

describe("loadCodingTunnelConfig", () => {
  it("is off when CODING_TUNNEL_PORT is unset or empty", () => {
    expect(loadCodingTunnelConfig({})).toBeUndefined();
    expect(loadCodingTunnelConfig({ CODING_TUNNEL_PORT: "  " })).toBeUndefined();
  });

  it("reads the port and the allowlist, with the starting limits", () => {
    expect(loadCodingTunnelConfig(valid)).toEqual({
      port: 8789,
      allowedHosts: ["registry.example.com"],
      maxConnections: 16,
      maxBytes: 4096 * MIB,
      idleMs: 120_000,
      maxDurationMs: 1_800_000,
    });
  });

  it("reads each limit", () => {
    expect(
      loadCodingTunnelConfig({
        ...valid,
        CODING_TUNNEL_MAX_CONNECTIONS: "4",
        CODING_TUNNEL_MAX_BYTES: "1000",
        CODING_TUNNEL_IDLE_MS: "5000",
        CODING_TUNNEL_MAX_DURATION_MS: "60000",
      }),
    ).toMatchObject({ maxConnections: 4, maxBytes: 1000, idleMs: 5000, maxDurationMs: 60_000 });
  });

  it("normalizes, trims and de-duplicates the allowlist", () => {
    const config = loadCodingTunnelConfig({
      ...valid,
      CODING_TUNNEL_ALLOWED_HOSTS: " Registry.Example.com , ghcr.io,registry.example.com. ",
    });
    expect(config?.allowedHosts).toEqual(["registry.example.com", "ghcr.io"]);
  });

  it.each(["0", "65536", "-1", "80.5", "eight", "1e3", "8787", "8788"])("refuses the port %j", (value) => {
    expect(() => loadCodingTunnelConfig({ ...valid, CODING_TUNNEL_PORT: value })).toThrow(/^CODING_TUNNEL_PORT /);
  });

  it("refuses to start with tunnel settings but no port", () => {
    expect(() => loadCodingTunnelConfig({ CODING_TUNNEL_ALLOWED_HOSTS: "ghcr.io" })).toThrow(
      "CODING_TUNNEL_PORT is required when another CODING_TUNNEL_* setting is set.",
    );
  });

  it("refuses an empty allowlist", () => {
    for (const hosts of [undefined, "", " , "]) {
      expect(() => loadCodingTunnelConfig({ CODING_TUNNEL_PORT: "8789", CODING_TUNNEL_ALLOWED_HOSTS: hosts })).toThrow(
        "CODING_TUNNEL_ALLOWED_HOSTS must list at least one host.",
      );
    }
  });

  it.each([
    ["an IPv4 literal", "93.184.216.34"],
    ["an IPv6 literal", "[2606:2800:220:1::1]"],
    ["a wildcard", "*.example.com"],
    ["a host with a port", "registry.example.com:443"],
    ["a URL", "https://registry.example.com"],
    ["a path", "registry.example.com/v2"],
    ["credentials", "user@registry.example.com"],
  ])("refuses %s in the allowlist", (_name, host) => {
    expect(() => loadCodingTunnelConfig({ ...valid, CODING_TUNNEL_ALLOWED_HOSTS: `ghcr.io,${host}` })).toThrow(
      "CODING_TUNNEL_ALLOWED_HOSTS must list bare hostnames only.",
    );
  });

  it.each([
    "CODING_TUNNEL_MAX_CONNECTIONS",
    "CODING_TUNNEL_MAX_BYTES",
    "CODING_TUNNEL_IDLE_MS",
    "CODING_TUNNEL_MAX_DURATION_MS",
  ])("refuses a bad %s", (name) => {
    for (const value of ["0", "-5", "1.5", "ten"]) {
      expect(() => loadCodingTunnelConfig({ ...valid, [name]: value })).toThrow(`${name} must be a positive integer.`);
    }
  });

  it("refuses an idle timeout longer than the maximum duration", () => {
    expect(() =>
      loadCodingTunnelConfig({ ...valid, CODING_TUNNEL_IDLE_MS: "90000", CODING_TUNNEL_MAX_DURATION_MS: "60000" }),
    ).toThrow("CODING_TUNNEL_IDLE_MS must not exceed CODING_TUNNEL_MAX_DURATION_MS.");
  });

  it("never echoes a setting's value in an error", () => {
    const secret = "fake-secret-value-123";
    const attempts: NodeJS.ProcessEnv[] = [
      { ...valid, CODING_TUNNEL_PORT: secret },
      { ...valid, CODING_TUNNEL_ALLOWED_HOSTS: `https://user:${secret}@host.example.com` },
      { ...valid, CODING_TUNNEL_ALLOWED_HOSTS: `${secret}:443` },
      { ...valid, CODING_TUNNEL_MAX_BYTES: secret },
      { ...valid, CODING_TUNNEL_IDLE_MS: secret },
    ];
    for (const env of attempts) {
      let message = "";
      try {
        loadCodingTunnelConfig(env);
      } catch (error) {
        message = String(error instanceof Error ? error.message : error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });
});

describe("loadCodingTunnelConfig TLS interception", () => {
  const rules = JSON.stringify([{ host: "Registry.Example.com.", scheme: "bearer", credential: "env:REGISTRY_TOKEN" }]);
  const intercept = {
    ...valid,
    CODING_TUNNEL_INTERCEPT_RULES: rules,
    CODING_TUNNEL_INTERCEPT_CA_CERT_FILE: "/etc/wardby/ca/tls.crt",
    CODING_TUNNEL_INTERCEPT_CA_KEY_FILE: "/etc/wardby/ca/tls.key",
  };
  const withRules = (value: unknown): NodeJS.ProcessEnv => ({
    ...intercept,
    CODING_TUNNEL_INTERCEPT_RULES: JSON.stringify(value),
  });

  it("is off unless all three settings are set", () => {
    expect(loadCodingTunnelConfig(valid)?.intercept).toBeUndefined();
  });

  it("reads the rules and the CA files", () => {
    expect(loadCodingTunnelConfig(intercept)?.intercept).toEqual({
      rules: [{ host: "registry.example.com", scheme: "bearer", credential: "env:REGISTRY_TOKEN" }],
      caCertFile: "/etc/wardby/ca/tls.crt",
      caKeyFile: "/etc/wardby/ca/tls.key",
    });
  });

  it("reads a basic rule with its user name", () => {
    const rule = {
      host: "registry.example.com",
      scheme: "basic",
      username: "oauth2accesstoken",
      credential: "env:REGISTRY_TOKEN",
    };
    expect(loadCodingTunnelConfig(withRules([rule]))?.intercept?.rules).toEqual([rule]);
  });

  it("reads a basic rule whose user name comes from an environment variable", () => {
    const rule = {
      host: "registry.example.com",
      scheme: "basic",
      usernameCredential: "env:REGISTRY_USER",
      credential: "env:REGISTRY_TOKEN",
    };
    expect(loadCodingTunnelConfig(withRules([rule]))?.intercept?.rules).toEqual([rule]);
  });

  it("reads a gcp rule, which names no credential: the proxy's own service account supplies it", () => {
    const rule = { host: "registry.example.com", scheme: "gcp" };
    expect(loadCodingTunnelConfig(withRules([rule]))?.intercept?.rules).toEqual([rule]);
  });

  it("requires the three settings together", () => {
    for (const name of [
      "CODING_TUNNEL_INTERCEPT_RULES",
      "CODING_TUNNEL_INTERCEPT_CA_CERT_FILE",
      "CODING_TUNNEL_INTERCEPT_CA_KEY_FILE",
    ]) {
      const env = { ...intercept, [name]: undefined };
      expect(() => loadCodingTunnelConfig(env)).toThrow("must be set together");
    }
  });

  it("refuses a rule that is malformed, repeats a host, or names a host the tunnel does not allow", () => {
    const rule = { host: "registry.example.com", scheme: "bearer", credential: "env:REGISTRY_TOKEN" };
    const cases: Array<[unknown, string]> = [
      ["not json", "JSON array"],
      [[], "JSON array"],
      [[{ ...rule, extra: 1 }], "JSON array"],
      [[{ ...rule, host: "10.0.0.1" }], "bare hostnames"],
      [[{ ...rule, host: "other.example.com" }], "listed in CODING_TUNNEL_ALLOWED_HOSTS"],
      [[rule, rule], "each host once"],
      [[{ ...rule, scheme: "digest" }], 'scheme must be "bearer", "basic" or "gcp"'],
      [[{ ...rule, scheme: "gcp" }], "gcp uses the proxy's own service account"],
      [[{ host: rule.host, scheme: "gcp", username: "oauth2accesstoken" }], "takes no credential or username"],
      [[{ ...rule, credential: "REGISTRY_TOKEN" }], "env:NAME reference"],
      [[{ ...rule, credential: "env:lowercase" }], "env:NAME reference"],
      [[{ ...rule, username: "user" }], "basic scheme only"],
      [[{ ...rule, scheme: "basic" }], "exactly one of username and usernameCredential"],
      [
        [{ ...rule, scheme: "basic", username: "u", usernameCredential: "env:REGISTRY_USER" }],
        "exactly one of username and usernameCredential",
      ],
      [[{ ...rule, scheme: "basic", usernameCredential: "REGISTRY_USER" }], "usernameCredential must be an env:NAME"],
      [[{ ...rule, usernameCredential: "env:REGISTRY_USER" }], "basic scheme only"],
      [[{ ...rule, scheme: "basic", username: "a:b" }], "basic needs a username"],
    ];
    for (const [value, message] of cases) {
      const env = typeof value === "string" ? { ...intercept, CODING_TUNNEL_INTERCEPT_RULES: value } : withRules(value);
      expect(() => loadCodingTunnelConfig(env)).toThrow(message);
    }
  });

  describe("with the CA as PEM text", () => {
    const keyBody = "ZmFrZS1jYS1rZXktbWFya2VyLTEyMw==";
    const pemCert = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\nZmFrZQ==\n-----END CERTIFICATE-----\n";
    const pemKey = `-----BEGIN PRIVATE KEY-----\n${keyBody}\n-----END PRIVATE KEY-----\n`;
    const withPem = {
      ...valid,
      CODING_TUNNEL_INTERCEPT_RULES: rules,
      CODING_TUNNEL_INTERCEPT_CA_CERT: pemCert,
      CODING_TUNNEL_INTERCEPT_CA_KEY: pemKey,
    };

    it("takes the certificate and key as text, a multi-line value intact", () => {
      const loaded = loadCodingTunnelConfig(withPem)?.intercept;
      expect(loaded?.caCertPem).toBe(pemCert);
      expect(loaded?.caKeyPem).toBe(pemKey);
      expect(loaded?.caCertFile).toBeUndefined();
      expect(loaded?.caKeyFile).toBeUndefined();
    });

    it("takes one of them as text and the other from a file", () => {
      const mixed = {
        ...withPem,
        CODING_TUNNEL_INTERCEPT_CA_KEY: undefined,
        CODING_TUNNEL_INTERCEPT_CA_KEY_FILE: "/ca/tls.key",
      };
      const loaded = loadCodingTunnelConfig(mixed)?.intercept;
      expect(loaded?.caCertPem).toBe(pemCert);
      expect(loaded?.caKeyFile).toBe("/ca/tls.key");
      expect(loaded?.caKeyPem).toBeUndefined();
    });

    it("refuses a part given both as text and as a file, without echoing the key", () => {
      const both = [
        { ...withPem, CODING_TUNNEL_INTERCEPT_CA_CERT_FILE: "/ca/tls.crt" },
        { ...withPem, CODING_TUNNEL_INTERCEPT_CA_KEY_FILE: "/ca/tls.key" },
      ];
      for (const env of both) {
        let message = "";
        try {
          loadCodingTunnelConfig(env);
        } catch (error) {
          message = String(error instanceof Error ? error.message : error);
        }
        expect(message).toContain("mutually exclusive");
        expect(message).not.toContain(keyBody);
      }
    });

    it("requires the rules, the certificate and the key together, in either form", () => {
      for (const name of [
        "CODING_TUNNEL_INTERCEPT_RULES",
        "CODING_TUNNEL_INTERCEPT_CA_CERT",
        "CODING_TUNNEL_INTERCEPT_CA_KEY",
      ]) {
        let message = "";
        try {
          loadCodingTunnelConfig({ ...withPem, [name]: undefined });
        } catch (error) {
          message = String(error instanceof Error ? error.message : error);
        }
        expect(message).toContain("must be set together");
        expect(message).not.toContain(keyBody);
      }
    });
  });

  it("refuses a CA file path that is not absolute", () => {
    expect(() => loadCodingTunnelConfig({ ...intercept, CODING_TUNNEL_INTERCEPT_CA_KEY_FILE: "tls.key" })).toThrow(
      "CODING_TUNNEL_INTERCEPT_CA_KEY_FILE must be an absolute file path.",
    );
  });

  it("is rejected when the tunnel itself is off", () => {
    const { CODING_TUNNEL_PORT: _port, ...withoutPort } = intercept;
    expect(() => loadCodingTunnelConfig(withoutPort)).toThrow("CODING_TUNNEL_PORT is required");
  });

  it("never echoes a rule's value, a credential name or a path in an error", () => {
    const secret = "fake-secret-value-123";
    const attempts: NodeJS.ProcessEnv[] = [
      { ...intercept, CODING_TUNNEL_INTERCEPT_RULES: `{"host":"${secret}"` },
      withRules([{ host: secret, scheme: "bearer", credential: "env:X" }]),
      withRules([{ host: "registry.example.com", scheme: secret, credential: "env:X" }]),
      withRules([{ host: "registry.example.com", scheme: "bearer", credential: secret }]),
      withRules([{ host: "registry.example.com", scheme: "basic", username: `${secret}:x`, credential: "env:X" }]),
      { ...intercept, CODING_TUNNEL_INTERCEPT_CA_KEY_FILE: secret },
    ];
    for (const env of attempts) {
      let message = "";
      try {
        loadCodingTunnelConfig(env);
      } catch (error) {
        message = String(error instanceof Error ? error.message : error);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(secret);
    }
  });
});

describe("loadCodingTunnelConfig CA trust", () => {
  it("is off unless CODING_TUNNEL_TRUST_CA_CERT_FILE is set", () => {
    expect(loadCodingTunnelConfig(valid)?.trustCaCertFile).toBeUndefined();
  });

  it("reads the file's absolute path, with or without interception", () => {
    const trust = { ...valid, CODING_TUNNEL_TRUST_CA_CERT_FILE: " /etc/wardby/ca/ca.crt " };
    expect(loadCodingTunnelConfig(trust)?.trustCaCertFile).toBe("/etc/wardby/ca/ca.crt");
    const intercept = {
      ...trust,
      CODING_TUNNEL_INTERCEPT_RULES: JSON.stringify([
        { host: "registry.example.com", scheme: "bearer", credential: "env:REGISTRY_TOKEN" },
      ]),
      CODING_TUNNEL_INTERCEPT_CA_CERT_FILE: "/etc/wardby/ca/tls.crt",
      CODING_TUNNEL_INTERCEPT_CA_KEY_FILE: "/etc/wardby/ca/tls.key",
    };
    expect(loadCodingTunnelConfig(intercept)?.trustCaCertFile).toBe("/etc/wardby/ca/ca.crt");
  });

  it("reads the certificate as PEM text, and refuses it given as text and as a file", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\nZmFrZQ==\n-----END CERTIFICATE-----\n";
    const loaded = loadCodingTunnelConfig({ ...valid, CODING_TUNNEL_TRUST_CA_CERT: pem });
    expect(loaded?.trustCaCertPem).toBe(pem);
    expect(loaded?.trustCaCertFile).toBeUndefined();
    expect(() =>
      loadCodingTunnelConfig({
        ...valid,
        CODING_TUNNEL_TRUST_CA_CERT: pem,
        CODING_TUNNEL_TRUST_CA_CERT_FILE: "/etc/wardby/ca/ca.crt",
      }),
    ).toThrow("mutually exclusive");
  });

  it("refuses a path that is not absolute, without echoing it", () => {
    const secret = "fake-relative-path-123";
    let message = "";
    try {
      loadCodingTunnelConfig({ ...valid, CODING_TUNNEL_TRUST_CA_CERT_FILE: secret });
    } catch (error) {
      message = String(error instanceof Error ? error.message : error);
    }
    expect(message).toBe("CODING_TUNNEL_TRUST_CA_CERT_FILE must be an absolute file path.");
    expect(message).not.toContain(secret);
  });

  it("is rejected when the tunnel itself is off", () => {
    expect(() => loadCodingTunnelConfig({ CODING_TUNNEL_TRUST_CA_CERT_FILE: "/etc/wardby/ca/ca.crt" })).toThrow(
      "CODING_TUNNEL_PORT is required",
    );
  });
});
