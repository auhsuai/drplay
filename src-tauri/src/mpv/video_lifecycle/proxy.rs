use std::sync::Arc;
use std::time::Duration;

use super::PROXY_HEADERS_TIMEOUT;

// ---------------------------------------------------------------------------
// Real proxy (src/stream_proxy/server.rs) with the PRODUCTION timeouts
// ---------------------------------------------------------------------------

/// Token source that never touches the OS vault or Google: the proxy still runs
/// its real code path, it just gets a fixed token.
struct FixedTokens;

impl crate::stream_proxy::TokenSource for FixedTokens {
    fn current(&self) -> Option<String> {
        Some(HARNESS_TOKEN.to_string())
    }

    fn refresh(
        self: Arc<Self>,
        _force: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>> {
        Box::pin(async { Ok(HARNESS_TOKEN.to_string()) })
    }
}

const HARNESS_TOKEN: &str = "harness-token-not-a-real-credential";

pub(super) fn spawn_real_proxy(upstream_port: u16, body_idle_timeout: Duration) -> u16 {
    let sink: crate::stream_proxy::server::ErrorSink = Arc::new(|_file_id, _status| {});
    crate::stream_proxy::server::spawn_proxy(
        sink,
        format!("http://127.0.0.1:{upstream_port}"),
        Arc::new(FixedTokens),
        PROXY_HEADERS_TIMEOUT,
        body_idle_timeout,
    )
    .expect("the real proxy must start")
}

/// The URL the frontend hands mpv: `buildProxyStreamUrl`
/// (src/lib/mpvProtocol.ts:169) is exactly this shape — localhost origin,
/// `/stream/`, the file id, nothing else.
pub(super) fn proxy_url(proxy_port: u16, file_id: &str) -> String {
    format!("http://127.0.0.1:{proxy_port}/stream/{file_id}")
}
