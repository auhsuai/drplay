#[derive(Debug, Clone)]
pub enum CoverError {
    BadId(String),
    NoCover,
    /// Disk read failed (permission, missing root init, corrupt state) — maps
    /// to HTTP 500 in mod.rs; the message is only for logs, never the response.
    DiskRead(String),
    /// Disk write failed (permission, disk full) — maps to HTTP 500.
    DiskWrite(String),
}
