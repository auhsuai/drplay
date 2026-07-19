"""Reusable Cloudflare R2 upload module (S3-compatible, boto3).

Uploads music cover art (full + 300px thumbnail) to R2 and returns object KEYS.
DB stores only the keys, keeping SQLite tiny.

Config can be loaded from a credentials text file (4-7 lines, see ghi_colab.txt)
or passed via overrides / environment variables.

No secrets are ever logged. Only track_id and high-level status are logged.
"""

import os
import time
import logging

try:
    import boto3
    from botocore.exceptions import (
        BotoCoreError,
        ClientError,
        EndpointConnectionError,
        ConnectionClosedError,
    )
    _BOTO3_AVAILABLE = True
except Exception:  # pragma: no cover - import guard, not silent swallow
    BotoCoreError = ClientError = EndpointConnectionError = ConnectionClosedError = Exception
    _BOTO3_AVAILABLE = False

logger = logging.getLogger("upload_to_r2")

DEFAULT_BUCKET = "drplay-assets"
DEFAULT_ENDPOINT = "https://59a34d91b6556633ba84c3852661809b.r2.cloudflarestorage.com"
DEFAULT_ACCOUNT_ID = "59a34d91b6556633ba84c3852661809b"
DEFAULT_REGION = "auto"

# Network / retry policy
MAX_RETRIES = 3
BACKOFF_BASE = 1.0  # seconds; exponential backoff


class R2UploadError(Exception):
    """Raised when both full + thumbnail upload to R2 fails after retries.

    Carries track_id and high-level context ONLY. Never a secret/key.
    """

    def __init__(self, track_id: str, context: str):
        self.track_id = track_id
        self.context = context
        super().__init__(f"R2 upload failed for track_id={track_id}: {context}")


def load_r2_config(config_path=None, account_id=None, access_key_id=None,
                   secret_access_key=None, endpoint_url=None, bucket=None):
    """Resolve R2 config from overrides, env vars, or a credentials file.

    Credentials file (ghi_colab.txt) lines are scanned for:
      'Access key ID:', 'Secret Access Key:', 'r2.cloudflarestorage.com',
      'Account ID:', 'Bucket name:'.
    """
    cfg = {
        "account_id": account_id or os.environ.get("R2_ACCOUNT_ID", DEFAULT_ACCOUNT_ID),
        "access_key_id": access_key_id or os.environ.get("R2_ACCESS_KEY_ID"),
        "secret_access_key": secret_access_key or os.environ.get("R2_SECRET_ACCESS_KEY"),
        "endpoint_url": endpoint_url or os.environ.get("R2_ENDPOINT_URL", DEFAULT_ENDPOINT),
        "bucket": bucket or os.environ.get("R2_BUCKET", DEFAULT_BUCKET),
        "region_name": DEFAULT_REGION,
    }

    if config_path and not (access_key_id and secret_access_key):
        try:
            with open(config_path, "r", encoding="utf-8") as fh:
                lines = fh.readlines()
        except OSError as exc:
            logger.warning(f"Could not read R2 config file at {config_path}: {exc}")
            lines = []
        for line in lines:
            low = line.lower()
            if "access key id" in low and ":" in line:
                cfg["access_key_id"] = line.split(":", 1)[1].strip()
            elif "secret access key" in low and ":" in line:
                cfg["secret_access_key"] = line.split(":", 1)[1].strip()
            elif "r2.cloudflarestorage.com" in low and "https://" in line:
                # take the URL token, skip 'jurisdiction-specific' label lines
                for tok in line.split():
                    if tok.startswith("https://") and "r2.cloudflarestorage.com" in tok:
                        cfg["endpoint_url"] = tok.strip().rstrip("/")
                        break
            elif "account id" in low and ":" in line:
                cfg["account_id"] = line.split(":", 1)[1].strip()
            elif "bucket name" in low and ":" in line:
                cfg["bucket"] = line.split(":", 1)[1].strip()

    if not cfg["access_key_id"] or not cfg["secret_access_key"]:
        raise R2UploadError("<config>", "missing access key id / secret access key")

    return cfg


def get_s3_client(cfg=None, config_path=None):
    """Build a boto3 S3 client pointed at Cloudflare R2."""
    if not _BOTO3_AVAILABLE:
        raise R2UploadError("<client>", "boto3 is not installed; run: pip install boto3")
    if cfg is None:
        cfg = load_r2_config(config_path=config_path)
    return boto3.client(
        service_name="s3",
        endpoint_url=cfg["endpoint_url"],
        aws_access_key_id=cfg["access_key_id"],
        aws_secret_access_key=cfg["secret_access_key"],
        region_name=cfg["region_name"],
    ), cfg


def _put_with_retry(s3_client, bucket, key, body, content_type, track_id):
    """Put one object with bounded exponential backoff (max 3, no infinite loop)."""
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            s3_client.put_object(
                Bucket=bucket,
                Key=key,
                Body=body,
                ContentType=content_type,
            )
            return
        except (EndpointConnectionError, ConnectionClosedError) as exc:
            last_exc = exc
            logger.warning(f"[try {attempt}/{MAX_RETRIES}] network error for {track_id} key={key}")
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            # 5xx / throttling are retryable; 4xx (auth/format) are not
            if code in ("InternalError", "ServiceUnavailable", "SlowDown", "500", "503"):
                last_exc = exc
                logger.warning(f"[try {attempt}/{MAX_RETRIES}] retryable ClientError {code} for {track_id}")
            else:
                raise
        except BotoCoreError as exc:
            last_exc = exc
            logger.warning(f"[try {attempt}/{MAX_RETRIES}] BotoCoreError for {track_id} key={key}")
        if attempt < MAX_RETRIES:
            time.sleep(BACKOFF_BASE * (2 ** (attempt - 1)))
    raise R2UploadError(track_id, f"put_object failed after {MAX_RETRIES} retries: {type(last_exc).__name__}")


def upload_cover(track_id, full_bytes, thumb_bytes, s3_client=None, cfg=None,
                 config_path=None, bucket=None):
    """Upload full + thumbnail cover to R2.

    Args:
        track_id: stable identifier (md5 hex of file path) used for the key.
        full_bytes: JPEG bytes of the full-resolution cover.
        thumb_bytes: JPEG bytes of the 300px thumbnail.
        s3_client: optional pre-built client.
        cfg: optional pre-resolved config dict.
        config_path: path to credentials file.
        bucket: override bucket name.

    Returns:
        (full_key, thumb_key) tuple of object keys, e.g.
        ("covers/<id>.jpg", "covers/<id>_thumb.jpg").

    Raises:
        R2UploadError: if both uploads fail after retries (no secrets in message).
    """
    if full_bytes is None and thumb_bytes is None:
        raise R2UploadError(track_id, "no cover bytes provided (both full and thumb are None)")

    own_client = False
    if s3_client is None:
        s3_client, resolved = get_s3_client(cfg=cfg, config_path=config_path)
        bucket = bucket or resolved["bucket"]
        own_client = True
    else:
        bucket = bucket or (cfg or {}).get("bucket") or DEFAULT_BUCKET

    full_key = f"covers/{track_id}.jpg"
    thumb_key = f"covers/{track_id}_thumb.jpg"

    try:
        if full_bytes is not None:
            _put_with_retry(s3_client, bucket, full_key, full_bytes, "image/jpeg", track_id)
        else:
            logger.warning(f"No full cover for {track_id}; skipping full key")
            full_key = None
        if thumb_bytes is not None:
            _put_with_retry(s3_client, bucket, thumb_key, thumb_bytes, "image/jpeg", track_id)
        else:
            logger.warning(f"No thumbnail for {track_id}; skipping thumb key")
            thumb_key = None
    finally:
        if own_client and hasattr(s3_client, "close"):
            try:
                s3_client.close()
            except Exception:
                pass

    if full_key is None and thumb_key is None:
        raise R2UploadError(track_id, "both uploads skipped (no bytes)")

    return full_key, thumb_key


if __name__ == "__main__":
    # CLI smoke test: python3 upload_to_r2.py <config_path> [track_id]
    import sys
    logging.basicConfig(level=logging.INFO)
    path = sys.argv[1] if len(sys.argv) > 1 else "cloudflare R2/ghi_colab.txt"
    tid = sys.argv[2] if len(sys.argv) > 2 else "smoke_test"
    k1, k2 = upload_cover(tid, b"\xff\xd8\xff\xe0SMOKE", b"\xff\xd8\xff\xe0SMOKE",
                          config_path=path)
    print(f"Uploaded: {k1}, {k2}")
