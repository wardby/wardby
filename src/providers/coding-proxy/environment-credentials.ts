import type { CredentialResolver } from "./types.js";

/** Resolves credential references only from the trusted proxy process environment. */
export class EnvironmentCredentialResolver implements CredentialResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(reference: string): Promise<string> {
    const match = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(reference);
    if (!match) throw new Error("coding_credential_reference_invalid");
    const value = this.env[match[1]];
    if (!value) throw new Error("coding_credential_unavailable");
    return value;
  }
}
