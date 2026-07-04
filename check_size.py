import sqlite3
conn = sqlite3.connect('c:/Users/thinkpad/Desktop/Antigravity/drplay/music_database.db')
print(conn.execute("SELECT length(cover_art), length(thumbnail) FROM tracks WHERE id = 'fc62e0fcc304a2da76bcba5ddeb887fb'").fetchall())
