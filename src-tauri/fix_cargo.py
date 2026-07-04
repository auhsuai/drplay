import re

with open('Cargo.toml', 'r', encoding='utf-8') as f:
    content = f.read()

# Remove all md5 and r2d2 lines
content = re.sub(r'^(md5|r2d2|r2d2_sqlite)\s*=.*$', '', content, flags=re.MULTILINE)
# Add them back correctly
content = content.strip() + '\n'
content += 'md5 = "0.7.0"\n'
content += 'r2d2 = "0.8"\n'
content += 'r2d2_sqlite = "0.24.0"\n'

with open('Cargo.toml', 'w', encoding='utf-8') as f:
    f.write(content)
