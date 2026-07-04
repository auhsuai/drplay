import re

with open('src/lib.rs', 'r', encoding='utf-8') as f:
    lib_content = f.read()

# 1. Update lib.rs setup to add r2d2 pool
lib_content = re.sub(
    r'\.setup\(\|app\|\s*\{',
    '.setup(|app| {\n            use r2d2_sqlite::SqliteConnectionManager;\n            use r2d2::Pool;\n            if let Some(db_path) = get_db_path() {\n                let manager = SqliteConnectionManager::file(&db_path);\n                if let Ok(pool) = Pool::new(manager) {\n                    app.manage(pool);\n                }\n            }',
    lib_content,
    count=1
)

# 2. Update get_local_metadata signature and logic in lib.rs
def repl_get_local(m):
    # m.group(0) is the entire function until the end
    s = m.group(0)
    s = s.replace(
        'fn get_local_metadata(size: i64, name: String) -> Option<LocalMetadata> {',
        "fn get_local_metadata(size: i64, name: String, pool: tauri::State<'_, r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>) -> Option<LocalMetadata> {"
    )
    s = s.replace(
        'use rusqlite::{Connection, OpenFlags};',
        ''
    )
    s = s.replace(
        'match Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {',
        'match pool.get() {'
    )
    # Replace query logic
    s = s.replace(
        'let query = if has_file_type {',
        'let name_like = format!("%{}%", name);\n                let query = if has_file_type {'
    )
    s = s.replace(
        'WHERE size_bytes = ?',
        'WHERE size_bytes = ? AND (file_path LIKE ? OR title LIKE ?)'
    )
    s = s.replace(
        'match stmt.query([size]) {',
        'match stmt.query(rusqlite::params![size, name_like, name_like]) {'
    )
    # Remove the manual filter
    # find `if file_path.contains(&name)` block and delete it
    s = re.sub(r'if file_path\.contains\(&name\).*?return Some\(meta\); // Perfect match\s*\}', '', s, flags=re.DOTALL)
    
    return s

lib_content = re.sub(r'fn get_local_metadata.*?\}\n    \}\n    None\n\}', repl_get_local, lib_content, flags=re.DOTALL)

with open('src/lib.rs', 'w', encoding='utf-8') as f:
    f.write(lib_content)


# 3. Update proxy.rs
with open('src/proxy.rs', 'r', encoding='utf-8') as f:
    proxy_content = f.read()

# Update AppState
proxy_content = proxy_content.replace(
    'pub struct AppState {',
    'pub struct AppState {\n    pub pool: r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>,'
)

# Update spawn_proxy_server
proxy_content = proxy_content.replace(
    'pub fn spawn_proxy_server(app_handle: AppHandle) {',
    'pub fn spawn_proxy_server(app_handle: AppHandle) {\n    let pool = app_handle.state::<r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>>().inner().clone();'
)
proxy_content = proxy_content.replace(
    'let state = AppState {\n        client: Client::builder()',
    'let state = AppState {\n        pool,\n        client: Client::builder()'
)

# Rewrite handle_cover entirely
handle_cover_new = """pub async fn handle_cover(
    State(state): State<AppState>,
    Query(query): Query<CoverQuery>,
    headers: HeaderMap,
) -> Response {
    let thumb = query.thumb.unwrap_or(false);
    let id_str = query.id;

    if id_str.is_empty() {
        return (StatusCode::BAD_REQUEST, "Missing ID").into_response();
    }

    let mut final_image: Option<Vec<u8>> = None;

    if let Some(db_path) = crate::get_db_path() {
        if let Some(parent) = db_path.parent() {
            if thumb {
                let thumb_dir = parent.join(".thumbnails");
                let thumb_path = thumb_dir.join(format!("{}.jpg", id_str));
                if thumb_path.exists() {
                    if let Ok(cached_cover) = std::fs::read(&thumb_path) {
                        final_image = Some(cached_cover);
                    }
                }
            }
        }
    }

    if final_image.is_none() {
        if let Ok(conn) = state.pool.get() {
            let has_thumb = conn.prepare("SELECT thumbnail FROM tracks LIMIT 1").is_ok();
            let sql_query = if thumb && has_thumb {
                "SELECT thumbnail, cover_art FROM tracks WHERE id = ? LIMIT 1"
            } else {
                "SELECT cover_art FROM tracks WHERE id = ? AND cover_art IS NOT NULL LIMIT 1"
            };

            if let Ok(mut stmt) = conn.prepare(sql_query) {
                if let Ok(mut rows) = stmt.query([&id_str]) {
                    if let Ok(Some(row)) = rows.next() {
                        let mut cover_art: Vec<u8> = Vec::new();
                        if thumb && has_thumb {
                            let t: Vec<u8> = row.get(0).unwrap_or_default();
                            if !t.is_empty() {
                                cover_art = t;
                            } else {
                                cover_art = row.get(1).unwrap_or_default();
                            }
                        } else {
                            cover_art = row.get(0).unwrap_or_default();
                        }
                        if !cover_art.is_empty() {
                            final_image = Some(cover_art);
                        }
                    }
                }
            }
        }
    }

    if let Some(image_bytes) = final_image {
        let expected_etag = format!("\\"{:x}\\"", md5::compute(&image_bytes));
        
        if let Some(if_none_match) = headers.get(header::IF_NONE_MATCH) {
            if if_none_match.to_str().unwrap_or("") == expected_etag {
                return Response::builder()
                    .status(StatusCode::NOT_MODIFIED)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(axum::body::Body::empty())
                    .unwrap();
            }
        }

        return Response::builder()
            .header(header::CONTENT_TYPE, "image/jpeg")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .header(header::ETAG, expected_etag)
            .body(axum::body::Body::from(image_bytes))
            .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response());
    }

    let transparent_pixel: Vec<u8> = vec![
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];
    
    Response::builder()
        .header(header::CONTENT_TYPE, "image/png")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .header(header::ETAG, "\\"transparent\\"")
        .body(axum::body::Body::from(transparent_pixel))
        .unwrap_or_else(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Failed").into_response())
}
"""

proxy_content = re.sub(r'pub async fn handle_cover\(.*?\n\}\n', handle_cover_new, proxy_content, flags=re.DOTALL)

with open('src/proxy.rs', 'w', encoding='utf-8') as f:
    f.write(proxy_content)
