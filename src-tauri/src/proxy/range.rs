pub fn parse_multi_range(range_str: &str, total_size: u64) -> Vec<(u64, u64)> {
    let prefix = "bytes=";
    let body = if let Some(s) = range_str.strip_prefix(prefix) { s } else { return vec![] };
    let mut ranges = Vec::new();
    for segment in body.split(',') {
        let seg = segment.trim();
        if let Some((start_str, end_str)) = seg.split_once('-') {
            let start_str = start_str.trim();
            let end_str = end_str.trim();

            // RFC 7233 suffix-byte-range-spec: "bytes=-500" means "the last
            // 500 bytes of the resource", not "start=0" — the previous
            // `start_str.parse().unwrap_or(0)` silently reinterpreted every
            // suffix-range request as the FIRST N bytes instead of the LAST
            // N. No client path in this app currently sends a suffix range,
            // so this was latent rather than user-visible, but it's still
            // spec-incorrect for any Range header that does use this form.
            if start_str.is_empty() {
                if let Ok(suffix_len) = end_str.parse::<u64>() {
                    if suffix_len > 0 && total_size > 0 {
                        let start = total_size.saturating_sub(suffix_len);
                        let end = total_size.saturating_sub(1);
                        ranges.push((start, end));
                    }
                }
                continue;
            }

            let start: u64 = start_str.parse().unwrap_or(0);
            let end: u64 = if end_str.is_empty() {
                total_size.saturating_sub(1)
            } else {
                end_str.parse().unwrap_or(total_size.saturating_sub(1))
            };
            if start <= end && start < total_size {
                ranges.push((start, end.min(total_size.saturating_sub(1))));
            }
        }
    }
    ranges
}
