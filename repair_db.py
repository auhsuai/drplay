import sqlite3

DB = "music_database.db"
con = sqlite3.connect(DB)
cur = con.cursor()

print("=== BEFORE ===")
for col in ("cover_url", "thumb_url", "file_type"):
    rows = [r[0] for r in cur.execute(f"SELECT {col} FROM tracks LIMIT 5")]
    print(col, "samples:", rows)
print("cover_url like covers/%:", cur.execute("SELECT COUNT(*) FROM tracks WHERE cover_url LIKE 'covers/%'").fetchone()[0])

# Repair: reconstruct cover_url / thumb_url from id (key is always covers/{id}.jpg)
cur.execute("""
    UPDATE tracks
    SET cover_url = 'covers/' || id || '.jpg',
        thumb_url = 'covers/' || id || '_thumb.jpg'
    WHERE id IS NOT NULL AND id != ''
""")
con.commit()

print("=== AFTER ===")
print("cover_url like covers/%:", cur.execute("SELECT COUNT(*) FROM tracks WHERE cover_url LIKE 'covers/%'").fetchone()[0])
print("thumb_url like covers/%:", cur.execute("SELECT COUNT(*) FROM tracks WHERE thumb_url LIKE 'covers/%'").fetchone()[0])
for col in ("cover_url", "thumb_url"):
    rows = [r[0] for r in cur.execute(f"SELECT {col} FROM tracks LIMIT 5")]
    print(col, "samples:", rows)
con.close()
print("DONE")
