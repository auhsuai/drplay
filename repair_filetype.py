import sqlite3, os

DB = "music_database.db"
con = sqlite3.connect(DB)
cur = con.cursor()

print("=== file_type BEFORE ===")
print([r[0] for r in cur.execute("SELECT file_type FROM tracks LIMIT 5")])

# file_type was clobbered by the column shift; derive it back from file_path extension.
cur.execute("UPDATE tracks SET file_type = LOWER(REPLACE(REPLACE(file_path, RTRIM(file_path, REPLACE(file_path, '.', '')), ''), '.', '')) WHERE file_path IS NOT NULL AND file_path != ''")
con.commit()

print("=== file_type AFTER ===")
print([r[0] for r in cur.execute("SELECT file_type FROM tracks LIMIT 5")])
print("null file_type count:", cur.execute("SELECT COUNT(*) FROM tracks WHERE file_type IS NULL OR file_type = ''").fetchone()[0])

# Sanity: only allow known extensions
cur.execute("UPDATE tracks SET file_type = '' WHERE file_type NOT IN ('mp3','m4a','flac','wav','ogg','aac','aiff','alac','opus')")
con.commit()
print("cleaned null/unknown file_type count:", cur.execute("SELECT COUNT(*) FROM tracks WHERE file_type IS NULL OR file_type = ''").fetchone()[0])
con.close()
print("DONE")
