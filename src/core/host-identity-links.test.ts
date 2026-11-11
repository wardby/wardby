import { describe, expect, it } from "vitest";
import { hostIdentityPurpose, oauthRedirectPath, oauthRedirectUri } from "./host-identity-links.js";
import { OAUTH_CALLBACK_PATH } from "./oauth-link.js";

describe("oauthRedirectPath", () => {
  it("keeps GitHub's registered Callback URL for the host-identity purpose", () => {
    expect(oauthRedirectPath(hostIdentityPurpose("github"))).toBe("/hosts/github/user-callback");
  });

  it("uses the shared callback for every other purpose", () => {
    expect(oauthRedirectPath("anything-else")).toBe(OAUTH_CALLBACK_PATH);
    expect(oauthRedirectPath("host-identity:unknown")).toBe(OAUTH_CALLBACK_PATH);
  });

  it("composes the full redirect URI from the origin", () => {
    expect(oauthRedirectUri("https://wardby.example", hostIdentityPurpose("github"))).toBe(
      "https://wardby.example/hosts/github/user-callback",
    );
    expect(oauthRedirectUri("https://wardby.example", "oauth-secret")).toBe("https://wardby.example/oauth/callback");
  });
});
