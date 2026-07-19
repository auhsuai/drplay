import sqlite3

DB = "music_database.db"
con = sqlite3.connect(DB)
cur = con.cursor()

print("=== BEFORE ===")
print("cover_url:", [r[0] for r in cur.execute("SELECT cover_url FROM tracks LIMIT 3")])
print("file_type:", [r[0] for r in cur.execute("SELECT file_type FROM tracks LIMIT 3")])

# Only the 3 columns cover_url/thumb_url/file_type were rotated by the scanner
# bug (file_type value landed in cover_url, cover_url landed in thumb_url,
# thumb_url landed in file_type). Metadata columns (bitrate..album_artist) are
# NOT shifted, so leave them alone.
#
# True values: file_type = current cover_url ('mp3'); cover_url/thumb_url were
# null (old scan failed upload) -> reconstruct deterministically from id.
cur.execute("""
    UPDATE tracks
    SET file_type  = CASE WHEN cover_url IS NOT NULL AND cover_url != '' THEN cover_url ELSE file_type END,
        cover_url  = 'covers/' || id || '.jpg',
        thumb_url  = 'covers/' || id || '_thumb.jpg'
    WHERE id IS NOT NULL AND id != ''
""")
con.commit()

print("=== AFTER ===")
print("cover_url:", [r[0] for r in cur.execute("SELECT cover_url FROM tracks LIMIT 3")])
print("file_type:", [r[0] for r in cur.execute("SELECT file_type FROM tracks LIMIT 3")])
print("cover_url valid:", cur.execute("SELECT COUNT(*) FROM tracks WHERE cover_url LIKE 'covers/%'").fetchone()[0])
print("file_type non-null:", cur.execute("SELECT COUNT(*) FROM tracks WHERE file_type IS NOT NULL AND file_type != ''").fetchone()[0])
print("bitrate untouched:", cur.execute("SELECT bitrate,sample_rate FROM tracks LIMIT 1").fetchone())
con.close()
print("DONE")
