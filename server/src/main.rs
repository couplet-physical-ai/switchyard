use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use parking_lot::RwLock;
use tracing::info;

use switchyard::api::{self, AppState};
use switchyard::auth::{Auth, AuthMode};
use switchyard::demo::{self, Fixtures};
use switchyard::history::{DiskHistory, History, MemHistory};
use switchyard::hub::Hub;
use switchyard::runtime::{self, Adapters, ReducerCfg};
use switchyard::store::{Store, StoreConfig};
use switchyard::wire::WireState;

#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[derive(Parser, Debug)]
#[command(
    name = "switchyard-server",
    version,
    about = "Switchyard: the live brain of a CI/CD fleet"
)]
struct Cli {
    /// Address to listen on.
    #[arg(long, env = "SWITCHYARD_LISTEN", default_value = "0.0.0.0:8080")]
    listen: SocketAddr,
    /// Serve the recorded fixtures (looping, shifted to now) instead of live upstreams.
    #[arg(long)]
    demo: bool,
    /// Fixtures directory for --demo.
    #[arg(long, env = "SWITCHYARD_FIXTURES", default_value = "contract/fixtures")]
    fixtures: PathBuf,
    /// Demo playback speed (1 = real time).
    #[arg(long, default_value_t = 1.0)]
    speed: f64,
    /// Web client build to serve at / (index.html fallback for client routes).
    #[arg(long, env = "SWITCHYARD_WEB_DIR", alias = "web-dir")]
    static_dir: Option<PathBuf>,
    /// State directory: history ring, checkpoints, device tokens.
    #[arg(long, env = "SWITCHYARD_DATA_DIR", default_value = "data")]
    data_dir: PathBuf,
    /// open = no auth (demo/local); platform = SSO edge + device tokens.
    #[arg(long, env = "SWITCHYARD_AUTH", default_value = "open")]
    auth: String,
    /// Header the SSO edge sets to the signed-in person's e-mail.
    #[arg(
        long,
        env = "SWITCHYARD_EMAIL_HEADER",
        default_value = "x-auth-request-email"
    )]
    email_header: String,
    /// Allowed e-mail domains for edge identities (comma list; empty = any).
    #[arg(long, env = "SWITCHYARD_EMAIL_DOMAINS", default_value = "")]
    email_domains: String,
    /// Public base URL (for /connect deep links and Origin checks).
    #[arg(long, env = "SWITCHYARD_PUBLIC_URL", default_value = "")]
    public_url: String,
    /// GitHub orgs to watch (comma list).
    #[arg(
        long,
        env = "SWITCHYARD_ORGS",
        default_value = "Northwind-Labs,Northwind-EMS,Northwind-Forge,couplet-physical-ai,copper-browser"
    )]
    orgs: String,
    /// Record fixtures: write the live snapshot + N minutes of frames into this directory.
    #[arg(long)]
    record: Option<PathBuf>,
    #[arg(long, default_value_t = 60)]
    record_minutes: u64,
    #[arg(long, default_value_t = 20)]
    record_settle_s: u64,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Print the version and exit.
    Version,
    /// Sanitize a recording for the public repo.
    Sanitize {
        #[arg(long = "in")]
        input: PathBuf,
        #[arg(long)]
        out: PathBuf,
        /// File with one public `owner/name` per line (kept verbatim).
        #[arg(long)]
        public_repos: Option<PathBuf>,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,hyper=warn,reqwest=warn".into()),
        )
        .with_target(false)
        .init();
    let cli = Cli::parse();
    match &cli.cmd {
        Some(Cmd::Version) => {
            println!(
                "switchyard-server {} ({})",
                env!("CARGO_PKG_VERSION"),
                git_sha()
            );
            return Ok(());
        }
        Some(Cmd::Sanitize {
            input,
            out,
            public_repos,
        }) => {
            let public: std::collections::BTreeSet<String> = match public_repos {
                Some(p) => std::fs::read_to_string(p)?
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect(),
                None => Default::default(),
            };
            let (bytes, frames) = switchyard::record::sanitize_dir(input, out, public)?;
            println!(
                "sanitized: snapshot {bytes} bytes, {frames} frames → {}",
                out.display()
            );
            return Ok(());
        }
        None => {}
    }
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(serve(cli))
}

fn git_sha() -> String {
    std::env::var("SWITCHYARD_GIT_SHA")
        .ok()
        .or_else(|| option_env!("SWITCHYARD_GIT_SHA").map(str::to_string))
        .unwrap_or_else(|| "dev".into())
}

async fn serve(cli: Cli) -> Result<()> {
    let clock = runtime::wall_clock();
    let orgs: Vec<String> = cli
        .orgs
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    std::fs::create_dir_all(&cli.data_dir)
        .with_context(|| format!("create {}", cli.data_dir.display()))?;
    let epoch = format!("{:x}", runtime::now_ms());
    let adapters = Arc::new(Adapters::default());
    let mode = match cli.auth.as_str() {
        "platform" => AuthMode::Platform,
        _ => AuthMode::Open,
    };
    let domains: Vec<String> = cli
        .email_domains
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut auth = Auth::new(
        mode,
        &cli.email_header,
        domains.clone(),
        Some(cli.data_dir.join("tokens.json")),
    );
    if mode == AuthMode::Platform {
        // Platform-stamped: the edge's OAuth client id(s), comma-separated.
        let auds: Vec<String> = std::env::var("EXOWATT_AUTH_AUDIENCE")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let doms: Vec<String> = std::env::var("EXOWATT_AUTH_ALLOWED_EMAIL_DOMAINS")
            .ok()
            .map(|v| {
                v.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or(domains);
        if auds.is_empty() {
            tracing::warn!("EXOWATT_AUTH_AUDIENCE unset: browser identities cannot be verified");
        }
        auth.google = Some(Arc::new(switchyard::google::GoogleVerifier::new(
            auds,
            doms,
            switchyard::adapters::http_client(),
        )));
        auth.trust_headers_without_jwt =
            std::env::var("SWITCHYARD_TRUST_HEADERS_WITHOUT_JWT").is_ok_and(|v| v == "true");
    }
    if let Ok(v) = std::env::var("SWITCHYARD_SERVICE_TOKENS") {
        auth.service_tokens = switchyard::auth::parse_service_tokens(&v);
        tracing::info!(n = auth.service_tokens.len(), "service tokens configured");
    }
    let auth = Arc::new(auth);

    let (hub, store) = if cli.demo {
        let dir = if cli.fixtures.join("snapshot.json").exists() {
            cli.fixtures.clone()
        } else {
            PathBuf::from("../contract/fixtures")
        };
        let fx = Arc::new(Fixtures::load(&dir)?);
        info!(
            frames = fx.frames.len(),
            period_ms = fx.period(),
            "demo mode: looping fixtures"
        );
        let hub = Hub::new(
            epoch,
            4096,
            4096,
            History::Mem(MemHistory::new(2 * fx.period() + 600_000)),
        );
        adapters.register("demo", true, Some(format!("fixtures {}", dir.display())));
        tokio::spawn(demo::run_demo(
            hub.clone(),
            fx,
            clock.clone(),
            adapters.clone(),
            cli.speed,
        ));
        (hub, None)
    } else {
        let hist = History::Disk(DiskHistory::open(&cli.data_dir.join("history"))?);
        let last = hist.last_seq();
        let hub = Hub::new(epoch, 4096, 8192, hist);
        hub.set_seq(last);
        let cfg = StoreConfig {
            orgs: orgs.clone(),
            ..Default::default()
        };
        let store = Arc::new(RwLock::new(Store::new(cfg)));
        let (tx, rx) = tokio::sync::mpsc::channel(1024);
        switchyard::adapters::spawn_all(
            &switchyard::adapters::UpstreamCfg::from_env(),
            &orgs,
            tx,
            adapters.clone(),
            clock.clone(),
        );
        tokio::spawn(runtime::run_reducer(
            store.clone(),
            hub.clone(),
            rx,
            clock.clone(),
            ReducerCfg::default(),
        ));
        (hub, Some(store))
    };

    if let Some(dir) = cli.record.clone() {
        let (h, a, m, settle) = (
            hub.clone(),
            adapters.clone(),
            cli.record_minutes,
            cli.record_settle_s,
        );
        tokio::spawn(async move {
            match switchyard::record::record(h, a, dir, m, settle).await {
                Ok(()) => info!("recording finished"),
                Err(e) => tracing::error!(error = %e, "recording failed"),
            }
        });
    }
    let mirror = Arc::new(RwLock::new(WireState::default()));
    tokio::spawn(api::run_mirror(hub.clone(), mirror.clone()));
    {
        let auth = auth.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                t.tick().await;
                auth.flush_if_dirty();
            }
        });
    }
    let st = Arc::new(AppState {
        hub,
        mirror,
        store,
        adapters,
        auth,
        traces: None,
        clock,
        mode: if cli.demo { "demo" } else { "live" },
        version: env!("CARGO_PKG_VERSION").to_string(),
        git_sha: git_sha(),
        orgs,
        static_dir: cli.static_dir.clone(),
        public_url: cli.public_url.clone(),
    });
    let app = api::router(st);
    let listener = tokio::net::TcpListener::bind(cli.listen)
        .await
        .with_context(|| format!("bind {}", cli.listen))?;
    info!(listen = %cli.listen, demo = cli.demo, "switchyard-server up");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn shutdown() {
    let ctrl_c = async {
        tokio::signal::ctrl_c().await.ok();
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
}
