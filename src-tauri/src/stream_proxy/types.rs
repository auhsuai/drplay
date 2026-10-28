//! Shared value types of the localhost stream proxy: the error-sink contract
//! and the context handed to both the upstream fetch and the response
//! mirroring half. Keeping them here makes the module graph a DAG:
//! `server` -> {`upstream`, `response`, `types`}, `upstream` -> `types`,
//! `response` -> `types`.

use std::{io, sync::Arc, time::Duration};

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;

use super::TokenSource;

/// Notified exactly once per failed file request with the fileId and a status:
/// a synthesized 502/504, the real upstream status for a non-2xx pass-through,
/// `BODY_ERROR_STATUS` when the upstream body fails mid-stream (the client has
/// already received its headers), or `IDLE_ABORT_STATUS` when the upstream body
/// stalls and the response is aborted. Never fired for 405/404-path/400 (not
/// file failures).
pub(crate) type ErrorSink = Arc<dyn Fn(String, u16) + Send + Sync>;

/// Status reported to the error sink when the upstream body errors mid-stream
/// (connection reset / early EOF after 200/206 already went on the wire): the
/// response is truncated, same class of client-visible failure as the idle
/// abort, so it is reported as a synthesized 502.
pub(super) const BODY_ERROR_STATUS: u16 = 502;

/// Status reported to the error sink when the upstream body goes idle
/// mid-stream and the response is aborted. The client has already received
/// 200/206 and sees a broken body instead; 499 never appears on the wire.
/// `pub(crate)` so stream_proxy's own tests can assert the exact reported status
/// instead of hardcoding 499 next to the constant.
pub(crate) const IDLE_ABORT_STATUS: u16 = 499;

pub(crate) struct ProxyContext {
    pub(super) client: reqwest::Client,
    pub(super) base_url: String,
    pub(super) tokens: Arc<dyn TokenSource>,
    pub(super) headers_timeout: Duration,
    pub(super) body_idle_timeout: Duration,
    pub(super) sink: ErrorSink,
}

/// Fixed-message or streamed upstream body. Un-sync because reqwest's byte
/// stream is `Send` but not provably `Sync`; hyper only needs `Send`.
pub(crate) type ProxyBody = UnsyncBoxBody<Bytes, io::Error>;
