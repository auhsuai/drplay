import sqlite3
import os

conn = sqlite3.connect('c:/Users/thinkpad/Desktop/Antigravity/drplay/music_database.db')
row = conn.execute("SELECT cover_art, thumbnail FROM tracks WHERE id = 'fc62e0fcc304a2da76bcba5ddeb887fb'").fetchone()

if row and row[0]:
    with open('c:/Users/thinkpad/Desktop/Antigravity/drplay/cover_art_test.jpg', 'wb') as f:
        f.write(row[0])

if row and row[1]:
    with open('c:/Users/thinkpad/Desktop/Antigravity/drplay/thumbnail_test.jpg', 'wb') as f:
        f.write(row[1])
