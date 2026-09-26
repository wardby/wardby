import { describe, expect, it, vi } from "vitest";
import { fakeGitHub, json } from "./github.test-support.js";
import { GitHubUserAuthorizer } from "./github-user-auth.js";

const CLIENT_ID = "Iv23liTestClient0001";
// A fixture, not a real secret.
const CLIENT_SECRET = "test-client-secret-0123456789abcdef0123";
const USER_TOKEN = "ghu_TestUserToken0123456789abcdefABCDEF";
const REDIRECT = "https://wardby.example/hosts/github/user-callback";

interface WebCall {
  url: string;
  method: string;
  body: Record<string, string>;
  accept: string | null;
}

function webFetch(respond: () => Response = () => json({ access_token: USER_TOKEN, token_type: "bearer" })) {
  const calls: WebCall[] = [];
  const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, string>,
      accept: new Headers(init?.headers).get("accept"),
    });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function setup(
  api: Parameters<typeof fakeGitHub>[0],
  respond?: () => Response,
): {
  authorizer: GitHubUserAuthorizer;
  apiCalls: ReturnType<typeof fakeGitHub>["calls"];
  webCalls: WebCall[];
} {
  const { client, calls } = fakeGitHub(api);
  const web = webFetch(respond);
  return {
    authorizer: new GitHubUserAuthorizer({
      client,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: web.fetchImpl,
    }),
    apiCalls: calls,
    webCalls: web.calls,
  };
}

const okApi: Parameters<typeof fakeGitHub>[0] = ({ method, path }) => {
  if (method === "GET" && path === "/user") return json({ id: 4242, login: "octo", type: "User" });
  if (method === "DELETE" && path === `/applications/${CLIENT_ID}/token`) return new Response(null, { status: 204 });
  return undefined;
};

const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;

describe("GitHubUserAuthorizer.authorizeUrl", () => {
  it("builds the web-flow URL with the client id, callback, state, and an S256 challenge", () => {
    const { authorizer } = setup(okApi);
    const url = new URL(authorizer.authorizeUrl({ state: "st4te", codeChallenge: "ch4llenge", redirectUri: REDIRECT }));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      state: "st4te",
      code_challenge: "ch4llenge",
      code_challenge_method: "S256",
      allow_signup: "false",
      prompt: "select_account",
    });
  });
});

describe("GitHubUserAuthorizer.complete", () => {
  it("exchanges the code with the verifier and secret, reads /user, and revokes the token", async () => {
    const { authorizer, apiCalls, webCalls } = setup(okApi);
    await expect(
      authorizer.complete({ code: "c0de", codeVerifier: "v".repeat(43), redirectUri: REDIRECT }),
    ).resolves.toEqual({ hostUserId: "4242", login: "octo" });
    expect(webCalls).toEqual([
      {
        url: "https://github.com/login/oauth/access_token",
        method: "POST",
        accept: "application/json",
        body: {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          code: "c0de",
          code_verifier: "v".repeat(43),
          redirect_uri: REDIRECT,
        },
      },
    ]);
    expect(apiCalls[0]).toMatchObject({ method: "GET", path: "/user", authorization: `Bearer ${USER_TOKEN}` });
    expect(apiCalls[1]).toMatchObject({
      method: "DELETE",
      path: `/applications/${CLIENT_ID}/token`,
      authorization: BASIC,
      body: { access_token: USER_TOKEN },
    });
  });

  it("revokes the token even when /user fails or is not a human user", async () => {
    for (const bad of [
      () => json({}, 500),
      () => json({ id: 1, login: "some-bot", type: "Bot" }),
      () => json({ id: "1", login: "octo", type: "User" }),
      () => json({ id: 1, login: 7, type: "User" }),
    ]) {
      const { authorizer, apiCalls } = setup(({ method, path }) => {
        if (method === "GET" && path === "/user") return bad();
        if (method === "DELETE") return new Response(null, { status: 204 });
        return undefined;
      });
      await expect(
        authorizer.complete({ code: "c", codeVerifier: "v".repeat(43), redirectUri: REDIRECT }),
      ).rejects.toThrow();
      expect(apiCalls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    }
  });

  it("still returns the user when revocation fails (the token is short-lived and never stored)", async () => {
    const { authorizer } = setup(({ method, path }) => {
      if (method === "GET" && path === "/user") return json({ id: 7, login: "octo", type: "User" });
      if (method === "DELETE") return json({}, 500);
      return undefined;
    });
    await expect(
      authorizer.complete({ code: "c", codeVerifier: "v".repeat(43), redirectUri: REDIRECT }),
    ).resolves.toEqual({
      hostUserId: "7",
      login: "octo",
    });
  });

  it("fails without calling the API when the exchange is refused, and never leaks the token or secret", async () => {
    for (const respond of [
      () => json({ error: "bad_verification_code", error_description: `nope ${CLIENT_SECRET}` }),
      () => json({ message: CLIENT_SECRET }, 401),
      () => json({ access_token: "has spaces and ${CLIENT_SECRET}" }),
    ]) {
      const { authorizer, apiCalls } = setup(okApi, respond);
      const err = await authorizer.complete({ code: "c", codeVerifier: "v".repeat(43), redirectUri: REDIRECT }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err).toBeInstanceOf(Error);
      expect(`${err!.message} ${String(err!.stack)}`).not.toContain(CLIENT_SECRET);
      expect(apiCalls).toHaveLength(0);
    }
    const failing = setup(({ method }) => (method === "GET" ? json({}, 500) : new Response(null, { status: 204 })));
    const err = await failing.authorizer
      .complete({ code: "c", codeVerifier: "v".repeat(43), redirectUri: REDIRECT })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err!.message).not.toContain(USER_TOKEN);
    expect(err!.message).not.toContain(CLIENT_SECRET);
  });
});
