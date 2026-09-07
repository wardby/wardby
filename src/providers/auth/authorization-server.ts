export interface SelfHostedAuthConfig {
  canonicalUri: string;
  signingKey: string;
  credentialHashKey: string;
  maxClients?: number;
}
export interface RegisterClientParams {
  redirectUris: string[];
  clientName?: string;
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
}
export interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string;
  state?: string;
}
export type TokenParams =
  | {
      grantType: "authorization_code";
      code: string;
      codeVerifier: string;
      redirectUri: string;
      clientId: string;
      resource?: string;
    }
  | { grantType: "refresh_token"; refreshToken: string; clientId: string; resource?: string };
export interface TokenResult {
  accessToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  refreshToken: string;
  scope: string;
}
