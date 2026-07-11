use r2d2_sqlite::SqliteConnectionManager;
use r2d2::Pool;

fn main() {
    let db_path = "../music_database.db";
    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::new(manager).unwrap();
    let conn = pool.get().unwrap();

    let mut stmt = conn.prepare("SELECT DISTINCT file_type FROM tracks").unwrap();
    let mut rows = stmt.query([]).unwrap();

    println!("File types in DB:");
    while let Ok(Some(row)) = rows.next() {
        let ft: String = row.get(0).unwrap_or_default();
        println!("- {}", ft);
    }
}
