import re

with open('src/proxy.rs', 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('use tauri::{AppHandle, Emitter};', 'use tauri::{AppHandle, Emitter, Manager};')
content = content.replace('let mut req = state.client.get', 'let req = state.client.get')
content = content.replace('let mut cover_art: Vec<u8> = Vec::new();', 'let cover_art: Vec<u8>;')
# Fix let mut cover_art = if ...
content = re.sub(
    r'let mut cover_art: Vec<u8>;\s*if thumb && has_thumb \{\s*let t: Vec<u8> = row\.get\(0\)\.unwrap_or_default\(\);\s*if !t\.is_empty\(\) \{\s*cover_art = t;\s*\} else \{\s*cover_art = row\.get\(1\)\.unwrap_or_default\(\);\s*\}\s*\} else \{\s*cover_art = row\.get\(0\)\.unwrap_or_default\(\);\s*\}',
    'let cover_art = if thumb && has_thumb {\n                            let t: Vec<u8> = row.get(0).unwrap_or_default();\n                            if !t.is_empty() {\n                                t\n                            } else {\n                                row.get(1).unwrap_or_default()\n                            }\n                        } else {\n                            row.get(0).unwrap_or_default()\n                        };',
    content,
    flags=re.DOTALL
)

with open('src/proxy.rs', 'w', encoding='utf-8') as f:
    f.write(content)


with open('src/lib.rs', 'r', encoding='utf-8') as f:
    lib_content = f.read()

lib_content = lib_content.replace('use std::sync::{atomic::{AtomicUsize, AtomicBool, Ordering}, OnceLock};', 'use std::sync::atomic::{AtomicUsize, AtomicBool, Ordering};')

with open('src/lib.rs', 'w', encoding='utf-8') as f:
    f.write(lib_content)
