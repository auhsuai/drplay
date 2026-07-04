use rusqlite::{Connection, OpenFlags};

fn main() {
    let size: i64 = 686475573;
    let name = "test".to_string();
    let db_path = std::path::PathBuf::from("c:/Users/thinkpad/Desktop/Antigravity/drplay/music_database.db");
    
    if let Ok(conn) = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        let has_file_type = conn.prepare("SELECT file_type FROM tracks LIMIT 1").is_ok();
        println!("has_file_type: {}", has_file_type);
        
        let query = if has_file_type {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, file_type, id FROM tracks WHERE size_bytes = ?"
        } else {
            "SELECT title, artist, album, duration, file_path, cover_art IS NOT NULL, '', id FROM tracks WHERE size_bytes = ?"
        };
        
        println!("query: {}", query);
        
        let mut stmt = conn.prepare(query).unwrap();
        let mut rows = stmt.query([size]).unwrap();
        
        let mut count = 0;
        while let Ok(Some(row)) = rows.next() {
            count += 1;
            let title: String = row.get(0).unwrap_or_default();
            let artist: String = row.get(1).unwrap_or_default();
            let duration: f64 = row.get(3).unwrap_or_default();
            let has_cover: bool = row.get(5).unwrap_or(false);
            let id: String = row.get(7).unwrap_or_default();
            println!("Row: title={}, artist={}, duration={}, has_cover={}, id={}", title, artist, duration, has_cover, id);
        }
        println!("Total rows: {}", count);
    } else {
        println!("Failed to open db");
    }
}
