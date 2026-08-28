#!/usr/bin/env python3
from pathlib import Path

path = Path("/etc/nginx/conf.d/everecho-api.conf")
text = path.read_text()

if "location ^~ /realtime/api/" in text:
    print("realtime block already present")
    raise SystemExit(0)

snippet = """
    location = /realtime {
        return 301 /realtime/;
    }

    location ^~ /realtime/api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
        client_max_body_size 2m;
    }

    location ^~ /realtime/ {
        alias /var/www/gpt-realtime-demo/;
        index index.html;
        try_files $uri $uri/ /realtime/index.html;
    }

"""

marker = "    location = /test-public.html {"
if marker not in text:
    raise SystemExit(f"marker not found in {path}")

path.write_text(text.replace(marker, snippet + marker, 1))
print("inserted realtime nginx locations")
