// R2 object storage access for album covers.
//
// SECURITY: R2 credentials live ONLY in `r2_config.json` next to the exe and are
// read at runtime. They are NEVER baked into the binary (no include_str!) and are
// NEVER exposed to the webview — the JS layer only ever sees the existing
// `http://drplay.localhost/cover?id=...&thumb=...` routes, proxied by protocol.rs.
//
// All errors are typed, logged with safe context (module, key, timestamp — NO
// secret/key value), and every caller falls back to a transparent PNG so a
// missing/erroring object can never crash the app or break the cover route.

use aws_sdk_s3::primitives::ByteStream;
use std::sync::OnceLock;

const MODULE: &str = "r2";

#[derive(Debug)]
pub enum R2Error {
    ConfigNotFound(std::path::PathBuf),
    ConfigParse(String),
    ClientBuild(String),
    GetObject(String),
    NotFound,
}

impl std::fmt::Display for R2Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            R2Error::ConfigNotFound(p) => write!(f, "r2 config not found at {:?}", p),
            R2Error::ConfigParse(e) => write!(f, "r2 config parse error: {}", e),
            R2Error::ClientBuild(e) => write!(f, "r2 client build error: {}", e),
            R2Error::GetObject(e) => write!(f, "r2 get_object error: {}", e),
            R2Error::NotFound => write!(f, "r2 object not found"),
        }
    }
}

impl std::error::Error for R2Error {}

#[derive(serde::Deserialize, Clone)]
struct R2Config {
    account_id: String,
    endpoint: String,
    bucket: String,
    region: String,
    access_key_id: String,
    secret_access_key: String,
}

fn config_path() -> std::path::PathBuf {
    // Read from the same directory as the running executable (NOT include_str!),
    // so the secret stays external & gitignored and is never baked into the binary.
    let mut dir = std::env::current_exe()
        .ok()
        .map(|mut p| {
            p.pop();
            p
        })
        .unwrap_or_default();
    dir.push("r2_config.json");
    dir
}

fn load_config() -> Result<R2Config, R2Error> {
    let path = config_path();
    let raw = std::fs::read_to_string(&path).map_err(|_| R2Error::ConfigNotFound(path.clone()))?;
    let cfg: R2Config = serde_json::from_str(&raw).map_err(|e| R2Error::ConfigParse(e.to_string()))?;
    Ok(cfg)
}

// One S3 client for the whole process, built once on first use.
static CLIENT: OnceLock<Option<aws_sdk_s3::Client>> = OnceLock::new();
// Bucket name is stable per config; cached alongside the client.
static BUCKET: OnceLock<String> = OnceLock::new();

fn get_client() -> Option<aws_sdk_s3::Client> {
    CLIENT
        .get_or_init(|| {
            let cfg = match load_config() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[{}] {}", MODULE, e);
                    return None;
                }
            };
            let bucket = cfg.bucket.clone();
            let creds = aws_sdk_s3::config::Credentials::new(
                cfg.access_key_id.clone(),
                cfg.secret_access_key.clone(),
                None,
                None,
                "r2",
            );
            let s3_cfg = aws_sdk_s3::config::Builder::new()
                .endpoint_url(cfg.endpoint.clone())
                .region(aws_sdk_s3::config::Region::new(cfg.region.clone()))
                .credentials_provider(creds)
                .force_path_style(true)
                .behavior_version(aws_sdk_s3::config::BehaviorVersion::latest())
                .build();
            BUCKET.get_or_init(|| bucket);
            Some(aws_sdk_s3::Client::from_conf(s3_cfg))
        })
        .clone()
}

/// Fetch an object's bytes from R2 by key.
///
/// Returns `R2Error::NotFound` when the object does not exist so the caller can
/// fall back to local/legacy sources. Never panics on network/HTTP errors; all
/// failures are typed and logged with safe (secret-free) context.
pub async fn get_cover_bytes(key: &str) -> Result<Vec<u8>, R2Error> {
    let client = match get_client() {
        Some(c) => c,
        None => return Err(R2Error::ClientBuild("client unavailable".into())),
    };
    let bucket = BUCKET.get().cloned().unwrap_or_default();

    let resp = client
        .get_object()
        .bucket(&bucket)
        .key(key)
        .send()
        .await;

    match resp {
        Ok(out) => {
            let data = out.body.collect().await.map_err(|e| {
                let ts = now_ts();
                eprintln!(
                    "[{}] get_object body collect failed key=<redacted> ts={} err={}",
                    MODULE, ts, e
                );
                R2Error::GetObject(format!("body_collect: {}", e))
            })?;
            Ok(data.into_bytes().to_vec())
        }
        Err(err) => {
            // S3Error is a typed, matchable error. Detect NoSuchKey / 404 to fall back.
            let ts = now_ts();
            let is_missing = format!("{:?}", err).contains("NoSuchKey")
                || format!("{:?}", err).to_lowercase().contains("nosuchkey");
            if is_missing {
                eprintln!(
                    "[{}] get_object not found key=<redacted> ts={}",
                    MODULE, ts
                );
                Err(R2Error::NotFound)
            } else {
                eprintln!(
                    "[{}] get_object failed key=<redacted> ts={} err={:?}",
                    MODULE, ts, err
                );
                Err(R2Error::GetObject(format!("{:?}", err)))
            }
        }
    }
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// Re-exported for a clean unused-import if `ByteStream` is referenced elsewhere;
// kept to document the upload API shape for future cover uploads to R2.
#[allow(dead_code)]
fn _upload_shape() -> ByteStream {
    ByteStream::from_static(&[])
}
