fn main() {
    let db_path = std::path::PathBuf::from("music_databasev2.db");
    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
        if let Ok(mut stmt) = conn.prepare("PRAGMA table_info(tracks);") {
            let mut rows = stmt.query([]).unwrap();
            while let Ok(Some(row)) = rows.next() {
                let name: String = row.get(1).unwrap();
                println!("{}", name);
            }
        }
    }
}
