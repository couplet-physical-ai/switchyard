//! Google ID token verification (the platform edge's oauth2-proxy forwards one
//! on every signed-in browser request; `gcloud auth print-identity-token`
//! mints one for people on the VPN). Same policy as the platform app-auth / roster:
//! RS256 against Google's JWKS (cached 1 h, refreshed once on an unknown kid),
//! issuer accounts.google.com, audience in `EXOWATT_AUTH_AUDIENCE` (comma
//! list), exp/iat/nbf with 10 s leeway, e-mail domain allow-list.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::sync::Mutex;

pub const JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS: [&str; 2] = ["https://accounts.google.com", "accounts.google.com"];
const LEEWAY_S: i64 = 10;
const JWKS_TTL: Duration = Duration::from_secs(3600);

#[derive(Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
    #[serde(default)]
    kty: String,
}

#[derive(Deserialize)]
struct Jwks {
    keys: Vec<Jwk>,
}

type Keys = HashMap<String, (Vec<u8>, Vec<u8>)>;

pub struct GoogleVerifier {
    pub audiences: Vec<String>,
    pub domains: Vec<String>,
    jwks_url: String,
    http: reqwest::Client,
    keys: Mutex<(Option<Instant>, Keys)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IdClaims {
    pub email: String,
    pub sub: String,
}

impl GoogleVerifier {
    pub fn new(
        audiences: Vec<String>,
        domains: Vec<String>,
        http: reqwest::Client,
    ) -> GoogleVerifier {
        GoogleVerifier {
            audiences,
            domains,
            jwks_url: JWKS_URL.into(),
            http,
            keys: Mutex::new((None, HashMap::new())),
        }
    }

    /// For tests: a fixed key set, no network.
    pub fn with_keys(
        audiences: Vec<String>,
        domains: Vec<String>,
        keys: Vec<(String, Vec<u8>, Vec<u8>)>,
    ) -> GoogleVerifier {
        let map: Keys = keys.into_iter().map(|(k, n, e)| (k, (n, e))).collect();
        GoogleVerifier {
            audiences,
            domains,
            jwks_url: String::new(),
            http: reqwest::Client::new(),
            keys: Mutex::new((
                Some(Instant::now() + Duration::from_secs(86_400 * 365)),
                map,
            )),
        }
    }

    async fn key(&self, kid: &str) -> Option<(Vec<u8>, Vec<u8>)> {
        let mut g = self.keys.lock().await;
        let fresh =
            g.0.is_some_and(|t| t.elapsed() < JWKS_TTL || self.jwks_url.is_empty());
        if fresh {
            if let Some(k) = g.1.get(kid) {
                return Some(k.clone());
            }
            if self.jwks_url.is_empty() {
                return None;
            }
        }
        // Stale, or an unknown kid (Google rotated): refresh once.
        let r = self
            .http
            .get(&self.jwks_url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .ok()?;
        let jwks: Jwks = r.json().await.ok()?;
        let mut map = HashMap::new();
        for k in jwks.keys {
            if !k.kty.is_empty() && k.kty != "RSA" {
                continue;
            }
            if let (Ok(n), Ok(e)) = (
                URL_SAFE_NO_PAD.decode(k.n.as_bytes()),
                URL_SAFE_NO_PAD.decode(k.e.as_bytes()),
            ) {
                map.insert(k.kid, (n, e));
            }
        }
        *g = (Some(Instant::now()), map);
        g.1.get(kid).cloned()
    }

    /// Verify a token; `None` on any failure (callers answer a uniform 401).
    pub async fn verify(&self, token: &str, now_s: i64) -> Option<IdClaims> {
        if self.audiences.is_empty() {
            return None;
        }
        let mut parts = token.split('.');
        let (h, p, sig) = (parts.next()?, parts.next()?, parts.next()?);
        if parts.next().is_some() {
            return None;
        }
        let header: Map<String, Value> =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(h).ok()?).ok()?;
        if header.get("alg").and_then(Value::as_str) != Some("RS256") {
            return None;
        }
        let kid = header.get("kid").and_then(Value::as_str)?;
        let (n, e) = self.key(kid).await?;
        let sig = URL_SAFE_NO_PAD.decode(sig).ok()?;
        let msg = &token[..h.len() + 1 + p.len()];
        RsaPublicKeyComponents { n: &n, e: &e }
            .verify(&RSA_PKCS1_2048_8192_SHA256, msg.as_bytes(), &sig)
            .ok()?;
        let claims: Map<String, Value> =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p).ok()?).ok()?;
        self.check_claims(&claims, now_s)
    }

    pub fn check_claims(&self, c: &Map<String, Value>, now: i64) -> Option<IdClaims> {
        let num = |k: &str| c.get(k).and_then(Value::as_f64).map(|x| x as i64);
        if num("iat").is_some_and(|t| t > now + LEEWAY_S)
            || num("nbf").is_some_and(|t| t > now + LEEWAY_S)
        {
            return None;
        }
        if num("exp").is_none_or(|t| t <= now - LEEWAY_S) {
            return None;
        }
        if !ISSUERS.contains(&c.get("iss").and_then(Value::as_str)?) {
            return None;
        }
        let auds: Vec<&str> = match c.get("aud")? {
            Value::String(s) => vec![s.as_str()],
            Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
            _ => return None,
        };
        if !self.audiences.iter().any(|a| auds.contains(&a.as_str())) {
            return None;
        }
        let email = c.get("email").and_then(Value::as_str)?.to_string();
        if c.get("email_verified").and_then(Value::as_bool) == Some(false) {
            return None;
        }
        let domain = email.rsplit_once('@')?.1.to_ascii_lowercase();
        if !self.domains.is_empty() && !self.domains.iter().any(|d| d.eq_ignore_ascii_case(&domain))
        {
            return None;
        }
        Some(IdClaims {
            email,
            sub: c
                .get("sub")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v() -> GoogleVerifier {
        GoogleVerifier::with_keys(
            vec!["aud-1".into(), "aud-2".into()],
            vec!["example.com".into()],
            vec![],
        )
    }

    fn claims(extra: Value) -> Map<String, Value> {
        let mut base = json!({"iss": "https://accounts.google.com", "aud": "aud-2", "email": "a@example.com",
                              "email_verified": true, "exp": 2000, "iat": 1000, "sub": "1"});
        for (k, x) in extra.as_object().unwrap() {
            base[k] = x.clone();
        }
        base.as_object().unwrap().clone()
    }

    #[test]
    fn accepts_good_claims() {
        assert_eq!(
            v().check_claims(&claims(json!({})), 1500).unwrap().email,
            "a@example.com"
        );
        assert!(
            v().check_claims(&claims(json!({"aud": ["x", "aud-1"]})), 1500)
                .is_some()
        );
        assert!(
            v().check_claims(&claims(json!({"iss": "accounts.google.com"})), 1500)
                .is_some()
        );
    }

    #[test]
    fn rejects_bad_claims() {
        let ver = v();
        assert!(
            ver.check_claims(&claims(json!({"exp": 1400})), 1500)
                .is_none(),
            "expired"
        );
        assert!(
            ver.check_claims(&claims(json!({"iat": 1600})), 1500)
                .is_none(),
            "future iat"
        );
        assert!(
            ver.check_claims(&claims(json!({"aud": "other"})), 1500)
                .is_none(),
            "aud"
        );
        assert!(
            ver.check_claims(&claims(json!({"iss": "https://evil"})), 1500)
                .is_none(),
            "iss"
        );
        assert!(
            ver.check_claims(&claims(json!({"email": "a@gmail.com"})), 1500)
                .is_none(),
            "domain"
        );
        assert!(
            ver.check_claims(&claims(json!({"email_verified": false})), 1500)
                .is_none(),
            "unverified"
        );
        let mut c = claims(json!({}));
        c.remove("exp");
        assert!(ver.check_claims(&c, 1500).is_none(), "no exp");
    }

    #[tokio::test]
    async fn rejects_malformed_and_unsigned_tokens() {
        let ver = v();
        assert!(ver.verify("nope", 1500).await.is_none());
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","kid":"k"}"#);
        let p = URL_SAFE_NO_PAD.encode(br#"{"email":"a@example.com"}"#);
        assert!(ver.verify(&format!("{h}.{p}."), 1500).await.is_none());
        let h = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","kid":"unknown"}"#);
        assert!(ver.verify(&format!("{h}.{p}.AAAA"), 1500).await.is_none());
    }
}
