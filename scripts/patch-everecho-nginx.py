#!/usr/bin/env python3
from pathlib import Path

path = Path("/etc/nginx/conf.d/everecho-api.conf")
text = path.read_text()
changed = False

ws_marker = "location ^~ /realtime/api/free-coach/transcribe"
ws_snippet = """
    location ^~ /realtime/api/free-coach/transcribe {
        proxy_pass http://127.0.0.1:8000/api/free-coach/transcribe;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

"""

if ws_marker not in text:
    api_marker = "    location ^~ /realtime/api/ {"
    if api_marker in text:
        text = text.replace(api_marker, ws_snippet + api_marker, 1)
        changed = True
    else:
        snippet = f"""
    location = /realtime {{
        return 301 /realtime/;
    }}
{ws_snippet}
    location ^~ /realtime/api/ {{
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        client_max_body_size 2m;
    }}

    location ^~ /realtime/ {{
        alias /var/www/voice-conversation-demo/;
        index index.html;
        try_files $uri $uri/ /realtime/index.html;
    }}

"""
        marker = "    location = /test-public.html {"
        if marker not in text:
            raise SystemExit(f"marker not found in {path}")
        text = text.replace(marker, snippet + marker, 1)
        changed = True

if "proxy_set_header Upgrade $http_upgrade;" not in text.split("location ^~ /realtime/api/")[1][:800]:
    old = """    location ^~ /realtime/api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
"""
    new = """    location ^~ /realtime/api/ {
        proxy_pass http://127.0.0.1:8000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
"""
    if old in text:
        text = text.replace(old, new, 1)
        changed = True

if changed:
    path.write_text(text)
    print("updated realtime nginx locations")
else:
    print("realtime websocket nginx block already present")
