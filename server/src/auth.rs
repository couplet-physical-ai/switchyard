//! Who may read the fleet.
//!
//! * Browsers come through the platform's SSO edge, which signs the person in
//!   and forwards `X-Auth-Request-Email` (oauth2-proxy). The edge strips any
//!   client-supplied copy on gated paths.
//! * The macOS app (and scripts) send `Authorization: Bearer syd_…`: a device
//!   token minted on the SSO-gated `/connect` page. Tokens are random 256-bit
//!   secrets; only their SHA-256 is stored; each can be revoked.
//! * `--auth open` (demo, local dev) allows everything.
//!
//! The stream paths may be listed in the edge's unauthenticated allow-list
//! (so a native client without a browser session can reach them); then this
//! module is what guards them: an unauthenticated request there gets 401.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{Html, IntoResponse, Response};
use base64::Engine;
use parking_lot::Mutex;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::api::AppState;
use crate::google::GoogleVerifier;
use crate::model::Ms;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    /// No checks at all (demo / local development).
    Open,
    /// Platform edge headers for browsers, device tokens for native clients.
    Platform,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TokenRec {
    pub id: String,
    pub email: String,
    pub name: String,
    pub created: Ms,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used: Option<Ms>,
    pub sha256: String,
    #[serde(default)]
    pub revoked: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct Principal {
    pub email: String,
    pub via: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_id: Option<String>,
}

pub struct Auth {
    pub mode: AuthMode,
    /// Verifies the Google ID token the edge forwards (and gcloud identity tokens).
    pub google: Option<Arc<GoogleVerifier>>,
    /// Dev-only escape hatch: trust the e-mail header without a verified token.
    pub trust_headers_without_jwt: bool,
    /// Header carrying the signed-in person's e-mail (from the edge).
    pub email_header: String,
    /// Allowed e-mail domain(s) for edge identities (empty = any).
    pub domains: Vec<String>,
    store_path: Option<PathBuf>,
    tokens: Mutex<BTreeMap<String, TokenRec>>,
    dirty: Mutex<bool>,
}

pub const TOKEN_PREFIX: &str = "syd_";

pub fn sha256_hex(s: &str) -> String {
    let d = Sha256::digest(s.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

impl Auth {
    pub fn new(
        mode: AuthMode,
        email_header: &str,
        domains: Vec<String>,
        store_path: Option<PathBuf>,
    ) -> Auth {
        let mut tokens = BTreeMap::new();
        if let Some(p) = &store_path
            && let Ok(b) = std::fs::read(p)
            && let Ok(v) = serde_json::from_slice::<Vec<TokenRec>>(&b)
        {
            for t in v {
                tokens.insert(t.sha256.clone(), t);
            }
        }
        Auth {
            mode,
            google: None,
            trust_headers_without_jwt: false,
            email_header: email_header.to_ascii_lowercase(),
            domains,
            store_path,
            tokens: Mutex::new(tokens),
            dirty: Mutex::new(false),
        }
    }

    fn domain_ok(&self, email: &str) -> bool {
        self.domains.is_empty()
            || self
                .domains
                .iter()
                .any(|d| email.to_ascii_lowercase().ends_with(&format!("@{d}")))
    }

    /// The person the SSO edge signed in: the e-mail header, confirmed by the
    /// Google ID token the edge forwards in `Authorization` (headers alone are
    /// spoofable by anyone who can reach the container directly).
    pub async fn edge_email(&self, h: &HeaderMap, now: Ms) -> Option<String> {
        let e = h
            .get(self.email_header.as_str())?
            .to_str()
            .ok()?
            .trim()
            .to_string();
        if e.is_empty() || !self.domain_ok(&e) {
            return None;
        }
        if let Some(g) = &self.google
            && let Some(tok) = Self::bearer(h)
            && let Some(c) = g.verify(&tok, now / 1000).await
        {
            return c.email.eq_ignore_ascii_case(&e).then_some(e);
        }
        self.trust_headers_without_jwt.then_some(e)
    }

    pub fn bearer(h: &HeaderMap) -> Option<String> {
        let v = h.get(header::AUTHORIZATION)?.to_str().ok()?;
        let t = v
            .strip_prefix("Bearer ")
            .or_else(|| v.strip_prefix("bearer "))?
            .trim();
        (!t.is_empty()).then(|| t.to_string())
    }

    pub fn check_token(&self, token: &str, now: Ms) -> Option<Principal> {
        if !token.starts_with(TOKEN_PREFIX) {
            return None;
        }
        let h = sha256_hex(token);
        let mut g = self.tokens.lock();
        let t = g.get_mut(&h)?;
        if t.revoked {
            return None;
        }
        // Record use at most once a minute (persisted lazily).
        if t.last_used.is_none_or(|l| now - l > 60_000) {
            t.last_used = Some(now);
            *self.dirty.lock() = true;
        }
        Some(Principal {
            email: t.email.clone(),
            via: "device_token",
            token_id: Some(t.id.clone()),
        })
    }

    pub async fn authenticate(
        &self,
        h: &HeaderMap,
        query_token: Option<&str>,
        now: Ms,
    ) -> Option<Principal> {
        if self.mode == AuthMode::Open {
            return Some(Principal {
                email: "anonymous".into(),
                via: "open",
                token_id: None,
            });
        }
        // 1. Browser through the edge (e-mail header + the edge's ID token).
        if h.contains_key(self.email_header.as_str()) {
            return self.edge_email(h, now).await.map(|email| Principal {
                email,
                via: "sso",
                token_id: None,
            });
        }
        let bearer = Self::bearer(h);
        // 2. Device token (header, or ?token= where headers are impossible).
        if let Some(t) = bearer.as_deref().or(query_token)
            && t.starts_with(TOKEN_PREFIX)
        {
            return self.check_token(t, now);
        }
        // 3. A Google ID token sent directly (gcloud identity token on the VPN).
        if let (Some(t), Some(g)) = (bearer, &self.google)
            && let Some(c) = g.verify(&t, now / 1000).await
        {
            return Some(Principal {
                email: c.email,
                via: "google_id_token",
                token_id: None,
            });
        }
        None
    }

    pub fn mint(&self, email: &str, name: &str, now: Ms) -> (String, TokenRec) {
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let token = format!(
            "{TOKEN_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw)
        );
        let mut idb = [0u8; 6];
        rand::thread_rng().fill_bytes(&mut idb);
        let id = idb.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let rec = TokenRec {
            id,
            email: email.to_string(),
            name: name.chars().take(80).collect(),
            created: now,
            last_used: None,
            sha256: sha256_hex(&token),
            revoked: false,
        };
        self.tokens.lock().insert(rec.sha256.clone(), rec.clone());
        self.persist();
        (token, rec)
    }

    pub fn list(&self, email: &str) -> Vec<TokenRec> {
        self.tokens
            .lock()
            .values()
            .filter(|t| t.email == email)
            .cloned()
            .collect()
    }

    pub fn revoke(&self, email: &str, id: &str) -> bool {
        let mut hit = false;
        for t in self.tokens.lock().values_mut() {
            if t.id == id && t.email == email {
                t.revoked = true;
                hit = true;
            }
        }
        if hit {
            self.persist();
        }
        hit
    }

    pub fn persist(&self) {
        let Some(p) = &self.store_path else { return };
        let v: Vec<TokenRec> = self.tokens.lock().values().cloned().collect();
        if let Ok(b) = serde_json::to_vec_pretty(&v) {
            let tmp = p.with_extension("tmp");
            if std::fs::write(&tmp, b).is_ok() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)).ok();
                }
                std::fs::rename(&tmp, p).ok();
            }
        }
        *self.dirty.lock() = false;
    }

    pub fn flush_if_dirty(&self) {
        if *self.dirty.lock() {
            self.persist();
        }
    }
}

#[derive(Deserialize)]
struct TokenQ {
    token: Option<String>,
}

/// Middleware for `/api/v1/*`.
pub async fn require(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let q: Option<TokenQ> = req.uri().query().and_then(serde_urlencoded_token);
    let now = (st.clock)();
    match st.auth.authenticate(req.headers(), q.as_ref().and_then(|t| t.token.as_deref()), now).await {
        Some(p) => {
            let mut req = req;
            req.extensions_mut().insert(p);
            next.run(req).await
        }
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "unauthorized", "message": "sign in through the browser, or send Authorization: Bearer <device token> (mint one at /connect)"})),
        )
            .into_response(),
    }
}

/// `?token=` for clients that cannot set headers on a WebSocket (browsers).
fn serde_urlencoded_token(q: &str) -> Option<TokenQ> {
    for kv in q.split('&') {
        if let Some(v) = kv.strip_prefix("token=") {
            return Some(TokenQ {
                token: Some(urldecode(v)),
            });
        }
    }
    None
}

fn urldecode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(x) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(x);
            i += 3;
            continue;
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub async fn whoami(axum::Extension(p): axum::Extension<Principal>) -> Response {
    Json(json!({"principal": p})).into_response()
}

pub async fn list_tokens(
    State(st): State<Arc<AppState>>,
    axum::Extension(p): axum::Extension<Principal>,
) -> Response {
    let v: Vec<serde_json::Value> = st
        .auth
        .list(&p.email)
        .into_iter()
        .map(|t| json!({"id": t.id, "name": t.name, "created": t.created, "last_used": t.last_used, "revoked": t.revoked}))
        .collect();
    Json(json!({"tokens": v})).into_response()
}

pub async fn revoke_token(
    State(st): State<Arc<AppState>>,
    axum::Extension(p): axum::Extension<Principal>,
    Path(id): Path<String>,
) -> Response {
    if st.auth.revoke(&p.email, &id) {
        Json(json!({"revoked": id})).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error": "unknown_token"})),
        )
            .into_response()
    }
}

#[derive(Deserialize, Default)]
pub struct MintReq {
    #[serde(default)]
    name: String,
}

/// Mint a device token. Only a browser session (edge identity) may mint: a
/// device token can never mint another.
pub async fn mint(
    State(st): State<Arc<AppState>>,
    headers: HeaderMap,
    body: Option<Json<MintReq>>,
) -> Response {
    let email = match st.auth.mode {
        AuthMode::Open => "local@localhost".to_string(),
        AuthMode::Platform => match st.auth.edge_email(&headers, (st.clock)()).await {
            Some(e) => e,
            None => {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({"error": "sign_in_required"})),
                )
                    .into_response();
            }
        },
    };
    // CSRF: browsers send Origin on POST; it must be ours.
    if let Some(o) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
        && !st.public_url.is_empty()
        && o.trim_end_matches('/') != st.public_url.trim_end_matches('/')
    {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "bad_origin"}))).into_response();
    }
    let name = body
        .map(|b| b.0.name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Switchyard for macOS".into());
    let (token, rec) = st.auth.mint(&email, &name, (st.clock)());
    let server = if st.public_url.is_empty() {
        "http://localhost:8080".to_string()
    } else {
        st.public_url.clone()
    };
    let link = format!(
        "switchyard://connect?server={}&token={}",
        urlencode(&server),
        urlencode(&token)
    );
    Json(json!({"token": token, "id": rec.id, "email": email, "server": server, "link": link}))
        .into_response()
}

fn urlencode(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            o.push(b as char);
        } else {
            o.push_str(&format!("%{b:02X}"));
        }
    }
    o
}

/// The SSO-gated page that connects the macOS app.
pub async fn connect_page(State(st): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let who = match st.auth.mode {
        AuthMode::Open => Some("local".to_string()),
        AuthMode::Platform => st.auth.edge_email(&headers, (st.clock)()).await,
    };
    let Some(who) = who else {
        return (
            StatusCode::UNAUTHORIZED,
            Html("<p>Sign in first.</p>".to_string()),
        )
            .into_response();
    };
    Html(CONNECT_HTML.replace("{{WHO}}", &html_escape(&who))).into_response()
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

const CONNECT_HTML: &str = include_str!("connect.html");
