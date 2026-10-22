//! OAuth 2.1 public-client flow against a wardby server: RFC 9728 / 8414
//! discovery, RFC 7591 registration, PKCE (RFC 7636), authorization URL, and
//! token exchange/refresh. Secrets (codes, verifiers, tokens) never appear in
//! errors or Debug output.

use std::fmt;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::Url;

use crate::error::AppError;

/// `offline_access` is required so the authorization server returns a refresh
/// token (sign-in fails without one); `admin:view` is the viewer's privileged
/// scope. The self-hosted AS ignores scopes it does not advertise, so the extra
/// scope is harmless there.
pub const SCOPE: &str = "admin:view offline_access";
pub const CLIENT_NAME: &str = "wardby viewer";
/// Redirect registered once per server; sign-in substitutes the bound port
/// (RFC 8252 section 7.3, which the wardby server honours).
pub const REGISTRATION_REDIRECT: &str = "http://127.0.0.1/callback";

/// HTTP client for all OAuth traffic: no redirects (a token endpoint must not
/// bounce credentials elsewhere) and bounded time.
pub fn http_client() -> Result<reqwest::Client, AppError> {
    build_client(client_builder().timeout(Duration::from_secs(30)))
}

/// The shared client settings (no redirects, user agent, rustls) without a
/// total timeout, so callers choose their own: the event stream is long-lived
/// and must not be cut off by a per-request deadline.
pub fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("wardby-viewer/", env!("CARGO_PKG_VERSION")))
}

pub fn build_client(b: reqwest::ClientBuilder) -> Result<reqwest::Client, AppError> {
    b.build()
        .map_err(|_| AppError::Network("could not build HTTP client".to_string()))
}

// ---------------------------------------------------------------- PKCE

pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl fmt::Debug for Pkce {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Pkce(<redacted>)")
    }
}

fn random_url_safe(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    rand::fill(&mut bytes[..]);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// S256 PKCE pair; the verifier is 64 url-safe characters (48 random bytes).
pub fn new_pkce() -> Pkce {
    let verifier = random_url_safe(48);
    let challenge = challenge_for(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

/// 32 url-safe characters (24 random bytes).
pub fn new_state() -> String {
    random_url_safe(24)
}

// ----------------------------------------------------------- discovery

#[derive(Debug, Clone)]
pub struct AuthServer {
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub registration_endpoint: Option<Url>,
    pub resource: String,
    /// The advertised issuer, already checked against the metadata's `issuer`.
    /// Also the expected value of the RFC 9207 `iss` callback parameter.
    pub issuer: String,
    /// RFC 9207: the server said it sends `iss` on authorization responses, so
    /// the callback must carry it (a mix-up defence that is useless if optional).
    pub iss_required: bool,
}

#[derive(Deserialize)]
struct ProtectedResource {
    resource: String,
    authorization_servers: Vec<String>,
}

#[derive(Deserialize)]
struct AsMetadata {
    issuer: String,
    authorization_endpoint: String,
    token_endpoint: String,
    registration_endpoint: Option<String>,
    #[serde(default)]
    authorization_response_iss_parameter_supported: bool,
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// Credentials only travel over https. Cleartext is for local development
/// only: a loopback host, and only when the server the user entered is itself
/// loopback (`local`), so a remote server cannot steer sign-in to cleartext.
fn require_secure(url: &Url, what: &str, local: bool) -> Result<(), AppError> {
    let ok = match url.scheme() {
        "https" => true,
        "http" => local && is_loopback_host(url),
        _ => false,
    };
    if ok && url.host_str().is_some() {
        Ok(())
    } else {
        Err(AppError::Protocol(format!("{what} must use https")))
    }
}

/// RFC 8615-style well-known URL: the well-known segment goes between the
/// origin and any path (RFC 9728 section 3.1, RFC 8414 section 3.1).
fn well_known(base: &Url, suffix: &str) -> Result<Url, AppError> {
    let mut u = base.clone();
    u.set_query(None);
    u.set_fragment(None);
    let path = base.path().trim_end_matches('/');
    u.set_path(&format!("/.well-known/{suffix}{path}"));
    Ok(u)
}

fn parse_endpoint(raw: &str, what: &str, local: bool) -> Result<Url, AppError> {
    let u = Url::parse(raw).map_err(|_| AppError::Protocol(format!("invalid {what}")))?;
    require_secure(&u, what, local)?;
    Ok(u)
}

async fn get_json<T: serde::de::DeserializeOwned>(
    http: &reqwest::Client,
    url: Url,
) -> Result<T, AppError> {
    let resp = http.get(url).send().await?;
    parse_json(resp).await
}

async fn parse_json<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
) -> Result<T, AppError> {
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Http {
            status: status.as_u16(),
        });
    }
    let body = read_capped(resp).await?;
    serde_json::from_slice(&body)
        .map_err(|_| AppError::Protocol("unexpected response shape".to_string()))
}

const MAX_EXPIRES_IN_SECS: u64 = 24 * 60 * 60;
/// Upper bound on any metadata, registration or token response body.
const MAX_BODY_BYTES: usize = 64 * 1024;

async fn read_capped(resp: reqwest::Response) -> Result<Vec<u8>, AppError> {
    read_capped_to(resp, MAX_BODY_BYTES).await
}

/// Reads a whole body, failing once it would exceed `max` bytes.
pub async fn read_capped_to(mut resp: reqwest::Response, max: usize) -> Result<Vec<u8>, AppError> {
    let too_big = || AppError::Protocol("response too large".to_string());
    if resp.content_length().is_some_and(|n| n > max as u64) {
        return Err(too_big());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        if body.len() + chunk.len() > max {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Protected-resource metadata: the path-inserted URL first (RFC 9728), then
/// the origin root, which wardby always serves. A 404 on both means the URL is
/// not a wardby server.
///
/// Also reports whether the path-inserted document is the one that answered:
/// only then does RFC 9728 section 3.3 let us demand that `resource` equal the
/// entered URL exactly (the root fallback describes the whole origin).
async fn fetch_prm(
    http: &reqwest::Client,
    server: &Url,
) -> Result<(ProtectedResource, bool), AppError> {
    let first = well_known(server, "oauth-protected-resource")?;
    let mut root = server.clone();
    root.set_path("/");
    let root = well_known(&root, "oauth-protected-resource")?;
    let candidates = if first == root {
        vec![first]
    } else {
        vec![first, root]
    };
    let path_inserted = candidates.len() == 2;
    for (i, url) in candidates.into_iter().enumerate() {
        match get_json::<ProtectedResource>(http, url).await {
            Ok(prm) => return Ok((prm, path_inserted && i == 0)),
            Err(AppError::Http { status: 404 }) => {}
            Err(e) => return Err(e),
        }
    }
    Err(AppError::NotWardby)
}

/// RFC 9728 section 3.3: the `resource` a document advertises is used as the
/// token audience, so it must belong to the server the user entered, or a
/// hostile server could collect tokens meant for another deployment that shares
/// its identity provider. The origin must match; when the path-inserted
/// document answered, the whole URL must match (ignoring a trailing slash).
fn check_resource(server: &Url, resource: &str, exact: bool) -> Result<(), AppError> {
    let mismatch = || AppError::Protocol("resource mismatch".to_string());
    let resource = Url::parse(resource).map_err(|_| mismatch())?;
    if resource.origin() != server.origin() {
        return Err(mismatch());
    }
    if exact {
        let norm = |u: &Url| {
            format!(
                "{}{}",
                u.origin().ascii_serialization(),
                u.path().trim_end_matches('/')
            )
        };
        if resource.query().is_some()
            || resource.fragment().is_some()
            || norm(&resource) != norm(server)
        {
            return Err(mismatch());
        }
    }
    Ok(())
}

pub async fn discover(http: &reqwest::Client, server_url: &str) -> Result<AuthServer, AppError> {
    let server = Url::parse(server_url.trim())
        .map_err(|_| AppError::Protocol("invalid server URL".to_string()))?;
    let local = is_loopback_host(&server);
    require_secure(&server, "server URL", local)?;

    let (prm, path_inserted) = fetch_prm(http, &server).await?;
    check_resource(&server, &prm.resource, path_inserted)?;
    let advertised = prm
        .authorization_servers
        .first()
        .ok_or_else(|| AppError::Protocol("no authorization server advertised".to_string()))?;
    let issuer = parse_endpoint(advertised, "authorization server", local)?;

    let meta = fetch_as_metadata(http, &issuer).await?;
    // RFC 8414 section 3.3: the metadata must name the issuer we asked about.
    if meta.issuer.trim_end_matches('/') != advertised.trim_end_matches('/') {
        return Err(AppError::Protocol(
            "authorization server issuer mismatch".to_string(),
        ));
    }
    Ok(AuthServer {
        authorization_endpoint: parse_endpoint(
            &meta.authorization_endpoint,
            "authorization endpoint",
            local,
        )?,
        token_endpoint: parse_endpoint(&meta.token_endpoint, "token endpoint", local)?,
        registration_endpoint: meta
            .registration_endpoint
            .as_deref()
            .map(|r| parse_endpoint(r, "registration endpoint", local))
            .transpose()?,
        resource: prm.resource,
        issuer: advertised.clone(),
        iss_required: meta.authorization_response_iss_parameter_supported,
    })
}

/// Candidate metadata URLs in MCP-spec order. wardby serves its metadata only
/// at the origin root, so the root form is tried for path issuers too.
fn metadata_candidates(issuer: &Url) -> Result<Vec<Url>, AppError> {
    let mut out = vec![well_known(issuer, "oauth-authorization-server")?];
    let path = issuer.path().trim_end_matches('/').to_string();
    if !path.is_empty() {
        let mut root = issuer.clone();
        root.set_path("/");
        out.push(well_known(&root, "oauth-authorization-server")?);
    }
    out.push(well_known(issuer, "openid-configuration")?);
    if !path.is_empty() {
        // OpenID Connect Discovery appends the segment to the issuer path.
        let mut u = issuer.clone();
        u.set_query(None);
        u.set_fragment(None);
        u.set_path(&format!("{path}/.well-known/openid-configuration"));
        out.push(u);
    }
    Ok(out)
}

async fn fetch_as_metadata(http: &reqwest::Client, issuer: &Url) -> Result<AsMetadata, AppError> {
    let mut last = AppError::Http { status: 404 };
    for url in metadata_candidates(issuer)? {
        match get_json::<AsMetadata>(http, url).await {
            Ok(meta) => return Ok(meta),
            Err(e @ AppError::Http { status: 404 }) => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

// -------------------------------------------------------- registration

#[derive(Deserialize)]
struct Registered {
    client_id: String,
}

/// Dynamic client registration; `NeedsClientId` when the server offers none.
pub async fn register(
    http: &reqwest::Client,
    as_: &AuthServer,
    redirect_uri: &str,
) -> Result<String, AppError> {
    let endpoint = as_
        .registration_endpoint
        .clone()
        .ok_or(AppError::NeedsClientId)?;
    let body = serde_json::json!({
        "redirect_uris": [redirect_uri],
        "client_name": CLIENT_NAME,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    let resp = http.post(endpoint).json(&body).send().await?;
    let reg: Registered = parse_json(resp).await?;
    if reg.client_id.is_empty() {
        return Err(AppError::Protocol("empty client id".to_string()));
    }
    Ok(reg.client_id)
}

// ----------------------------------------------------- authorize URL

pub fn authorize_url(
    as_: &AuthServer,
    client_id: &str,
    redirect_uri: &str,
    pkce: &Pkce,
    state: &str,
) -> Url {
    let mut url = as_.authorization_endpoint.clone();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", &as_.resource);
    url
}

// -------------------------------------------------------------- tokens

pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: Option<Instant>,
}

impl fmt::Debug for Tokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Tokens")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
}

async fn token_request(
    http: &reqwest::Client,
    as_: &AuthServer,
    form: &[(&str, &str)],
) -> Result<Tokens, AppError> {
    let resp = http
        .post(as_.token_endpoint.clone())
        .form(form)
        .send()
        .await?;
    let t: TokenResponse = parse_json(resp).await?;
    if !t.token_type.eq_ignore_ascii_case("bearer") {
        return Err(AppError::Protocol("unsupported token type".to_string()));
    }
    if t.access_token.is_empty() {
        return Err(AppError::Protocol("empty access token".to_string()));
    }
    Ok(Tokens {
        access_token: t.access_token,
        refresh_token: t.refresh_token.filter(|r| !r.is_empty()),
        // Capped at a day; a value that would overflow Instant means "unknown".
        expires_at: t.expires_in.and_then(|s| {
            Instant::now().checked_add(Duration::from_secs(s.min(MAX_EXPIRES_IN_SECS)))
        }),
    })
}

pub async fn exchange_code(
    http: &reqwest::Client,
    as_: &AuthServer,
    client_id: &str,
    redirect_uri: &str,
    code: &str,
    pkce: &Pkce,
) -> Result<Tokens, AppError> {
    token_request(
        http,
        as_,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", client_id),
            ("code_verifier", &pkce.verifier),
            ("resource", &as_.resource),
        ],
    )
    .await
}

pub async fn refresh(
    http: &reqwest::Client,
    as_: &AuthServer,
    client_id: &str,
    refresh_token: &str,
) -> Result<Tokens, AppError> {
    token_request(
        http,
        as_,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", client_id),
            ("resource", &as_.resource),
        ],
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Match, Mock, MockServer, Request, ResponseTemplate};

    #[test]
    fn pkce_matches_rfc7636_appendix_b() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_pkce_and_state_shapes() {
        let p = new_pkce();
        assert_eq!(p.verifier.len(), 64);
        assert!(
            p.verifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_eq!(p.challenge, challenge_for(&p.verifier));
        let s = new_state();
        assert_eq!(s.len(), 32);
        assert!(
            s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_ne!(new_state(), s);
        assert_ne!(new_pkce().verifier, p.verifier);
    }

    #[test]
    fn debug_output_redacts_secrets() {
        let p = Pkce {
            verifier: "VERIFIER".into(),
            challenge: "CHAL".into(),
        };
        assert!(!format!("{p:?}").contains("VERIFIER"));
        let t = Tokens {
            access_token: "ACCESS".into(),
            refresh_token: Some("REFRESH".into()),
            expires_at: None,
        };
        let d = format!("{t:?}");
        assert!(!d.contains("ACCESS") && !d.contains("REFRESH"));
    }

    fn as_for(base: &str) -> AuthServer {
        AuthServer {
            authorization_endpoint: Url::parse(&format!("{base}/authorize")).unwrap(),
            token_endpoint: Url::parse(&format!("{base}/token")).unwrap(),
            registration_endpoint: Some(Url::parse(&format!("{base}/register")).unwrap()),
            resource: format!("{base}/mcp"),
            issuer: format!("{base}/mcp"),
            iss_required: false,
        }
    }

    fn pairs(url: &Url) -> Vec<(String, String)> {
        url.query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect()
    }

    #[test]
    fn authorize_url_has_every_param_exactly_once() {
        let as_ = as_for("https://wardby.example");
        let pkce = Pkce {
            verifier: "v".into(),
            challenge: "CH".into(),
        };
        let url = authorize_url(&as_, "cid", "http://127.0.0.1:5555/callback", &pkce, "ST");
        assert_eq!(url.path(), "/authorize");
        let p = pairs(&url);
        let expect = [
            ("response_type", "code"),
            ("client_id", "cid"),
            ("redirect_uri", "http://127.0.0.1:5555/callback"),
            ("scope", "admin:view offline_access"),
            ("state", "ST"),
            ("code_challenge", "CH"),
            ("code_challenge_method", "S256"),
            ("resource", "https://wardby.example/mcp"),
        ];
        assert_eq!(p.len(), expect.len());
        for (k, v) in expect {
            let found: Vec<_> = p.iter().filter(|(pk, _)| pk == k).collect();
            assert_eq!(found.len(), 1, "param {k}");
            assert_eq!(found[0].1, v, "param {k}");
        }
        assert!(!url.as_str().contains("verifier"));
    }

    #[tokio::test]
    async fn discovers_prm_then_as_metadata() {
        let s = MockServer::start().await;
        let base = s.uri();
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "resource": format!("{base}/mcp"),
                "authorization_servers": [base],
                "scopes_supported": ["admin:view"],
            })))
            .expect(1)
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/authorize"),
                "token_endpoint": format!("{base}/token"),
                "registration_endpoint": format!("{base}/register"),
            })))
            .expect(1)
            .mount(&s)
            .await;
        let a = discover(&http_client().unwrap(), &base).await.unwrap();
        assert_eq!(
            a.authorization_endpoint.as_str(),
            format!("{base}/authorize")
        );
        assert_eq!(a.token_endpoint.as_str(), format!("{base}/token"));
        assert_eq!(
            a.registration_endpoint.unwrap().as_str(),
            format!("{base}/register")
        );
        assert_eq!(a.resource, format!("{base}/mcp"));
    }

    #[tokio::test]
    async fn discovery_without_registration_endpoint_then_register_needs_client_id() {
        let s = MockServer::start().await;
        let base = s.uri();
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "resource": base, "authorization_servers": [base],
            })))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "issuer": base,
                "authorization_endpoint": format!("{base}/authorize"),
                "token_endpoint": format!("{base}/token"),
            })))
            .mount(&s)
            .await;
        let http = http_client().unwrap();
        let a = discover(&http, &base).await.unwrap();
        assert!(a.registration_endpoint.is_none());
        let err = register(&http, &a, REGISTRATION_REDIRECT)
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NeedsClientId));
    }

    #[tokio::test]
    async fn discovery_falls_back_to_root_prm_for_a_path_url() {
        let s = MockServer::start().await;
        let base = s.uri();
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "resource": format!("{base}/"),
                "authorization_servers": [format!("{base}/")],
            })))
            .mount(&s)
            .await;
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "issuer": format!("{base}/"),
                "authorization_endpoint": format!("{base}/authorize"),
                "token_endpoint": format!("{base}/token"),
            })))
            .mount(&s)
            .await;
        let a = discover(&http_client().unwrap(), &format!("{base}/mcp"))
            .await
            .unwrap();
        // The OAuth resource is what the server's metadata says, not the entered URL.
        assert_eq!(a.resource, format!("{base}/"));
    }

    async fn mount_as(s: &MockServer, base: &str) {
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(as_meta(base, base)))
            .mount(s)
            .await;
    }

    async fn mount_prm_at(s: &MockServer, at: &str, resource: &str, issuer: &str) {
        Mock::given(method("GET"))
            .and(path(at))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "resource": resource, "authorization_servers": [issuer],
            })))
            .mount(s)
            .await;
    }

    #[tokio::test]
    async fn resource_on_another_origin_is_rejected() {
        let s = MockServer::start().await;
        let base = s.uri();
        mount_prm_at(
            &s,
            "/.well-known/oauth-protected-resource",
            "https://other-deployment.example/mcp",
            &base,
        )
        .await;
        mount_as(&s, &base).await;
        let err = discover(&http_client().unwrap(), &base).await.unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "resource mismatch"));
    }

    #[tokio::test]
    async fn unparseable_resource_is_rejected() {
        let s = MockServer::start().await;
        let base = s.uri();
        mount_prm_at(
            &s,
            "/.well-known/oauth-protected-resource",
            "not a url",
            &base,
        )
        .await;
        mount_as(&s, &base).await;
        let err = discover(&http_client().unwrap(), &base).await.unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "resource mismatch"));
    }

    #[tokio::test]
    async fn path_inserted_prm_must_name_exactly_the_entered_url() {
        let s = MockServer::start().await;
        let base = s.uri();
        mount_as(&s, &base).await;
        // Same origin but a different path: the path-inserted document claims
        // to describe /mcp yet names /other.
        mount_prm_at(
            &s,
            "/.well-known/oauth-protected-resource/mcp",
            &format!("{base}/other"),
            &base,
        )
        .await;
        let http = http_client().unwrap();
        let err = discover(&http, &format!("{base}/mcp")).await.unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "resource mismatch"));

        s.reset().await;
        mount_as(&s, &base).await;
        mount_prm_at(
            &s,
            "/.well-known/oauth-protected-resource/mcp",
            &format!("{base}/mcp"),
            &base,
        )
        .await;
        let a = discover(&http, &format!("{base}/mcp")).await.unwrap();
        assert_eq!(a.resource, format!("{base}/mcp"));
    }

    #[tokio::test]
    async fn root_fallback_may_name_a_different_path_on_the_same_origin() {
        let s = MockServer::start().await;
        let base = s.uri();
        mount_as(&s, &base).await;
        mount_prm_at(
            &s,
            "/.well-known/oauth-protected-resource",
            &format!("{base}/mcp"),
            &base,
        )
        .await;
        let a = discover(&http_client().unwrap(), &format!("{base}/admin"))
            .await
            .unwrap();
        assert_eq!(a.resource, format!("{base}/mcp"));
    }

    #[tokio::test]
    async fn discovery_with_no_metadata_anywhere_is_not_wardby() {
        let s = MockServer::start().await;
        let err = discover(&http_client().unwrap(), &format!("{}/mcp", s.uri()))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::NotWardby));
        assert_eq!(err.kind(), "not_wardby");
    }

    #[tokio::test]
    async fn discovery_errors_are_typed() {
        let s = MockServer::start().await;
        let base = s.uri();
        let http = http_client().unwrap();
        // 404 on PRM
        let err = discover(&http, &base).await.unwrap_err();
        assert!(matches!(err, AppError::NotWardby));
        // empty authorization_servers
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "resource": base, "authorization_servers": [],
            })))
            .mount(&s)
            .await;
        assert!(matches!(
            discover(&http, &base).await.unwrap_err(),
            AppError::Protocol(_)
        ));
    }

    #[tokio::test]
    async fn discovery_refuses_cleartext_remote_hosts() {
        let http = http_client().unwrap();
        let err = discover(&http, "http://wardby.example.com")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(_)));
    }

    #[test]
    fn well_known_inserts_before_path() {
        let u = Url::parse("https://h.example/api/").unwrap();
        assert_eq!(
            well_known(&u, "oauth-protected-resource").unwrap().as_str(),
            "https://h.example/.well-known/oauth-protected-resource/api"
        );
        let u = Url::parse("https://h.example").unwrap();
        assert_eq!(
            well_known(&u, "x").unwrap().as_str(),
            "https://h.example/.well-known/x"
        );
    }

    #[tokio::test]
    async fn register_sends_documented_body_and_returns_client_id() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .and(header("content-type", "application/json"))
            .and(body_json(serde_json::json!({
                "redirect_uris": ["http://127.0.0.1/callback"],
                "client_name": "wardby viewer",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "client_id": "client-123",
                "token_endpoint_auth_method": "none",
                "redirect_uris": ["http://127.0.0.1/callback"],
            })))
            .expect(1)
            .mount(&s)
            .await;
        let id = register(
            &http_client().unwrap(),
            &as_for(&s.uri()),
            REGISTRATION_REDIRECT,
        )
        .await
        .unwrap();
        assert_eq!(id, "client-123");
    }

    #[tokio::test]
    async fn register_surfaces_http_status() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/register"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&s)
            .await;
        let err = register(
            &http_client().unwrap(),
            &as_for(&s.uri()),
            REGISTRATION_REDIRECT,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Http { status: 400 }));
    }

    /// Matches a form body with exactly these key/value pairs.
    struct ExactForm(BTreeMap<String, String>);
    impl Match for ExactForm {
        fn matches(&self, req: &Request) -> bool {
            let got: BTreeMap<String, String> = url::form_urlencoded::parse(&req.body)
                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                .collect();
            got == self.0
        }
    }
    fn form(pairs: &[(&str, &str)]) -> ExactForm {
        ExactForm(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    #[tokio::test]
    async fn exchange_code_posts_form_and_parses_tokens() {
        let s = MockServer::start().await;
        let as_ = as_for(&s.uri());
        let pkce = Pkce {
            verifier: "the-verifier".into(),
            challenge: "c".into(),
        };
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(header("content-type", "application/x-www-form-urlencoded"))
            .and(form(&[
                ("grant_type", "authorization_code"),
                ("code", "the code"),
                ("redirect_uri", "http://127.0.0.1:5555/callback"),
                ("client_id", "cid"),
                ("code_verifier", "the-verifier"),
                ("resource", &as_.resource),
            ]))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "AT", "token_type": "Bearer", "expires_in": 600,
                "refresh_token": "RT", "scope": "admin:view",
            })))
            .expect(1)
            .mount(&s)
            .await;
        let before = Instant::now();
        let t = exchange_code(
            &http_client().unwrap(),
            &as_,
            "cid",
            "http://127.0.0.1:5555/callback",
            "the code",
            &pkce,
        )
        .await
        .unwrap();
        assert_eq!(t.access_token, "AT");
        assert_eq!(t.refresh_token.as_deref(), Some("RT"));
        let exp = t.expires_at.unwrap();
        assert!(exp >= before + Duration::from_secs(600));
        assert!(exp <= Instant::now() + Duration::from_secs(600));
    }

    #[tokio::test]
    async fn refresh_posts_form_and_handles_missing_refresh_token() {
        let s = MockServer::start().await;
        let as_ = as_for(&s.uri());
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", "old-rt"),
                ("client_id", "cid"),
                ("resource", &as_.resource),
            ]))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "AT2", "token_type": "Bearer",
            })))
            .expect(1)
            .mount(&s)
            .await;
        let t = refresh(&http_client().unwrap(), &as_, "cid", "old-rt")
            .await
            .unwrap();
        assert_eq!(t.access_token, "AT2");
        assert!(t.refresh_token.is_none());
        assert!(t.expires_at.is_none());
    }

    #[tokio::test]
    async fn token_errors_carry_status_but_no_secrets() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(400).set_body_json(
                    serde_json::json!({"error": "invalid_grant", "echo": "SECRET-RT"}),
                ),
            )
            .mount(&s)
            .await;
        let err = refresh(
            &http_client().unwrap(),
            &as_for(&s.uri()),
            "cid",
            "SECRET-RT",
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Http { status: 400 }));
        assert!(!err.to_string().contains("SECRET"));
    }

    #[tokio::test]
    async fn token_redirects_are_not_followed() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(307).insert_header("location", "http://127.0.0.1:1/steal"),
            )
            .mount(&s)
            .await;
        let err = refresh(&http_client().unwrap(), &as_for(&s.uri()), "cid", "rt")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Http { status: 307 }));
    }

    #[tokio::test]
    async fn malformed_token_body_is_protocol_error() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&s)
            .await;
        let err = refresh(&http_client().unwrap(), &as_for(&s.uri()), "cid", "rt")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(_)));
    }

    async fn mount_prm(s: &MockServer, issuer: &str) {
        let base = s.uri();
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-protected-resource"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "resource": format!("{base}/mcp"), "authorization_servers": [issuer],
            })))
            .mount(s)
            .await;
    }

    fn as_meta(base: &str, issuer: &str) -> serde_json::Value {
        serde_json::json!({
            "issuer": issuer,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"),
        })
    }

    #[tokio::test]
    async fn path_issuer_falls_back_to_root_metadata_like_wardby() {
        let s = MockServer::start().await;
        let base = s.uri();
        let issuer = format!("{base}/mcp");
        mount_prm(&s, &issuer).await;
        // Only the root path is mounted, as wardby serves it.
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(as_meta(&base, &issuer)))
            .expect(1)
            .mount(&s)
            .await;
        let a = discover(&http_client().unwrap(), &base).await.unwrap();
        assert_eq!(a.issuer, issuer);
        assert_eq!(a.token_endpoint.as_str(), format!("{base}/token"));
    }

    #[tokio::test]
    async fn path_issuer_prefers_path_inserted_metadata() {
        let s = MockServer::start().await;
        let base = s.uri();
        let issuer = format!("{base}/mcp");
        mount_prm(&s, &issuer).await;
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server/mcp"))
            .respond_with(ResponseTemplate::new(200).set_body_json(as_meta(&base, &issuer)))
            .expect(1)
            .mount(&s)
            .await;
        assert!(discover(&http_client().unwrap(), &base).await.is_ok());
    }

    #[tokio::test]
    async fn falls_back_to_openid_configuration_for_external_idps() {
        let s = MockServer::start().await;
        let base = s.uri();
        let issuer = format!("{base}/tenant");
        mount_prm(&s, &issuer).await;
        Mock::given(method("GET"))
            .and(path("/tenant/.well-known/openid-configuration"))
            .respond_with(ResponseTemplate::new(200).set_body_json(as_meta(&base, &issuer)))
            .expect(1)
            .mount(&s)
            .await;
        let a = discover(&http_client().unwrap(), &base).await.unwrap();
        assert_eq!(a.issuer, issuer);
    }

    #[test]
    fn cleartext_is_only_for_a_loopback_host_of_a_loopback_server() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(require_secure(&u("https://wardby.example/x"), "x", false).is_ok());
        assert!(require_secure(&u("http://127.0.0.1:9/x"), "x", true).is_ok());
        assert!(require_secure(&u("http://localhost/x"), "x", true).is_ok());
        // A remote server must not steer sign-in to a cleartext endpoint, even a local one.
        assert!(require_secure(&u("http://127.0.0.1:9/x"), "x", false).is_err());
        assert!(require_secure(&u("http://idp.example/x"), "x", true).is_err());
    }

    #[tokio::test]
    async fn iss_parameter_support_is_read_from_metadata() {
        let s = MockServer::start().await;
        let base = s.uri();
        mount_prm(&s, &base).await;
        let mut meta = as_meta(&base, &base);
        meta["authorization_response_iss_parameter_supported"] = serde_json::json!(true);
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(meta))
            .mount(&s)
            .await;
        let http = http_client().unwrap();
        assert!(discover(&http, &base).await.unwrap().iss_required);

        s.reset().await;
        mount_prm(&s, &base).await;
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(ResponseTemplate::new(200).set_body_json(as_meta(&base, &base)))
            .mount(&s)
            .await;
        assert!(!discover(&http, &base).await.unwrap().iss_required);
    }

    #[tokio::test]
    async fn issuer_mismatch_is_rejected() {
        let s = MockServer::start().await;
        let base = s.uri();
        mount_prm(&s, &base).await;
        Mock::given(method("GET"))
            .and(path("/.well-known/oauth-authorization-server"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(as_meta(&base, "https://evil.example")),
            )
            .mount(&s)
            .await;
        let err = discover(&http_client().unwrap(), &base).await.unwrap_err();
        assert!(matches!(err, AppError::Protocol(_)));
    }

    #[tokio::test]
    async fn oversized_response_is_rejected() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_string("x".repeat(100 * 1024)))
            .mount(&s)
            .await;
        let err = refresh(&http_client().unwrap(), &as_for(&s.uri()), "cid", "rt")
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Protocol(m) if m == "response too large"));
    }

    #[tokio::test]
    async fn non_bearer_token_type_is_rejected_and_case_is_ignored() {
        let s = MockServer::start().await;
        let as_ = as_for(&s.uri());
        let http = http_client().unwrap();
        for (tt, ok) in [("DPoP", false), ("bearer", true), ("BEARER", true)] {
            s.reset().await;
            Mock::given(method("POST"))
                .and(path("/token"))
                .respond_with(
                    ResponseTemplate::new(200)
                        .set_body_json(serde_json::json!({"access_token": "AT", "token_type": tt})),
                )
                .mount(&s)
                .await;
            assert_eq!(refresh(&http, &as_, "cid", "rt").await.is_ok(), ok, "{tt}");
        }
        s.reset().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({"access_token": "AT"})),
            )
            .mount(&s)
            .await;
        assert!(refresh(&http, &as_, "cid", "rt").await.is_err());
    }

    #[tokio::test]
    async fn huge_expires_in_does_not_panic() {
        let s = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_string(
                r#"{"access_token":"AT","token_type":"Bearer","expires_in":18446744073709551615}"#,
            ))
            .mount(&s)
            .await;
        let t = refresh(&http_client().unwrap(), &as_for(&s.uri()), "cid", "rt")
            .await
            .unwrap();
        let e = t.expires_at.unwrap();
        assert!(e <= Instant::now() + Duration::from_secs(24 * 60 * 60));
    }
}
