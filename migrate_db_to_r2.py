"""Migrate existing music_database.db cover BLOBs to Cloudflare R2.

For each track that has cover_art/thumbnail BLOB but NULL cover_url/thumb_url,
re-upload the bytes to R2, set the keys, then NULL out the BLOBs to shrink the DB.
Runs VACUUM at the end. Safe to run repeatedly (idempotent).

Usage:
    python3 migrate_db_to_r2.py [db_path]

    db_path defaults to: env MUSIC_DB_PATH or "music_database.db"
    R2 config: env vars or the credentials file at
    "cloudflare R2/ghi_colab.txt" (relative to script dir).

No secrets logged. One bad row never crashes the run (skip + count).
"""

import os
import sys
import sqlite3
import logging

try:
    from tqdm import tqdm
except Exception:  # pragma: no cover
    tqdm = None

from upload_to_r2 import upload_cover, R2UploadError, load_r2_config, get_s3_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("migrate_db_to_r2")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_CONFIG = os.path.join(SCRIPT_DIR, "cloudflare R2", "ghi_colab.txt")


def human_size(num_bytes):
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024.0:
            return f"{size:.2f} {unit}"
        size /= 1024.0
    return f"{size:.2f} TB"


def migrate(db_path, config_path=DEFAULT_CONFIG):
    cfg = load_r2_config(config_path=config_path)
    s3_client, resolved = get_s3_client(cfg=cfg)
    bucket = resolved["bucket"]

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Ensure the new columns exist (older DBs may not have them).
    for col in ("cover_url", "thumb_url"):
        try:
            cur.execute(f"ALTER TABLE tracks ADD COLUMN {col} TEXT")
        except sqlite3.OperationalError:
            pass  # already exists

    before_size = os.path.getsize(db_path)

    cur.execute(
        "SELECT id, cover_art, thumbnail FROM tracks "
        "WHERE (cover_art IS NOT NULL OR thumbnail IS NOT NULL) "
        "AND cover_url IS NULL"
    )
    rows = cur.fetchall()
    total = len(rows)
    logger.info(f"Found {total} rows to migrate in {db_path}")

    migrated = 0
    failed = 0

    iterator = tqdm(rows, desc="Migrating covers") if tqdm else rows

    for track_id, full_blob, thumb_blob in iterator:
        try:
            full_key, thumb_key = upload_cover(
                track_id, full_blob, thumb_blob,
                s3_client=s3_client, cfg=resolved, bucket=bucket,
            )
            cur.execute(
                "UPDATE tracks SET cover_url=?, thumb_url=?, cover_art=NULL, thumbnail=NULL WHERE id=?",
                (full_key, thumb_key, track_id),
            )
            migrated += 1
        except R2UploadError as exc:
            failed += 1
            logger.warning(f"Migrate skip track_id={exc.track_id}: {exc.context}")
        except Exception as exc:  # non-R2 unexpected (e.g. bad BLOB decode upstream)
            failed += 1
            logger.warning(f"Migrate skip track_id={track_id}: unexpected {type(exc).__name__}")

    conn.commit()
    after_size_pre_vacuum = os.path.getsize(db_path)
    logger.info(f"Pre-VACUUM: {human_size(after_size_pre_vacuum)}; running VACUUM...")
    cur.execute("VACUUM")
    conn.commit()
    conn.close()

    after_size = os.path.getsize(db_path)

    logger.info("=== Migration summary ===")
    logger.info(f"Total to migrate : {total}")
    logger.info(f"Migrated (ok)    : {migrated}")
    logger.info(f"Failed/skipped   : {failed}")
    logger.info(f"DB size before   : {human_size(before_size)}")
    logger.info(f"DB size after    : {human_size(after_size)} "
                f"(freed {human_size(max(0, before_size - after_size))})")
    return {"total": total, "migrated": migrated, "failed": failed,
            "before": before_size, "after": after_size}


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("MUSIC_DB_PATH", "music_database.db")
    if not os.path.exists(db):
        logger.error(f"DB not found: {db}")
        sys.exit(2)
    migrate(db)
