import sqlite3

DB = "music_database.db"
con = sqlite3.connect(DB)
cur = con.cursor()

print("=== BEFORE (sample row) ===")
r = cur.execute("SELECT bitrate,sample_rate,bit_depth,channels,genre,year,track_number,album_artist FROM tracks LIMIT 1").fetchone()
print("bitrate,sr,bit_depth,ch,genre,year,track_no,album_artist =", r)

# The scanner wrote values shifted LEFT by 1 starting at file_type, so every
# column from bitrate..album_artist holds the value of the NEXT column.
# Reconstruct by shifting RIGHT by 1 ( album_artist is lost -> null ).
rows = cur.execute("SELECT id,bitrate,sample_rate,bit_depth,channels,genre,year,track_number,album_artist FROM tracks").fetchall()
upd = 0
for (id_, bitrate, sr, bd, ch, genre, year, tn, aa) in rows:
    # column-bitrate should hold value currently in 'sr' (the true bitrate)
    # column-sample_rate should hold value currently in 'bd'
    # column-bit_depth should hold value currently in 'ch'
    # column-channels should hold value currently in 'genre'
    # column-genre should hold value currently in 'year'
    # column-year should hold value currently in 'track_number'
    # column-track_number should hold value currently in 'album_artist'
    # column-album_artist -> null (shifted out)
    cur.execute(
        """UPDATE tracks SET
            bitrate=?, sample_rate=?, bit_depth=?, channels=?,
            genre=?, year=?, track_number=?, album_artist=NULL
           WHERE id=?""",
        (sr, bd, ch, genre, year, tn, aa, id_),
    )
    upd += 1
con.commit()

print("rows updated:", upd)
print("=== AFTER (sample row) ===")
r = cur.execute("SELECT bitrate,sample_rate,bit_depth,channels,genre,year,track_number,album_artist FROM tracks LIMIT 1").fetchone()
print("bitrate,sr,bit_depth,ch,genre,year,track_no,album_artist =", r)
con.close()
print("DONE")
