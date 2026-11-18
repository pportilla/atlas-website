"""Start a separate Atlas prompt and resolution service inside each user's runtime."""

import os
import re
from pathlib import Path


def relative_resolution_urls(response):
    """Keep the upstream workspace's assets and API calls under its Jupyter URL."""
    content_type = response.headers.get("Content-Type", "").split(";")[0]
    if content_type == "text/html":
        response.body = re.sub(rb"""(\b(?:src|href)=["'])/(?!/)""", rb"\1./", response.body)
    elif content_type in {"text/javascript", "application/javascript"}:
        response.body = re.sub(rb"""(["'`])/api/""", rb"\1./api/", response.body)


atlas = str(Path(os.environ.get("ATLAS_ROOT", "/opt/atlas")) / "atlas")
config = get_config()
config.ServerProxy.servers = {
    "atlas-terminal": {
        # ttyd allocates a real PTY and starts Atlas directly for each connection.
        "command": ["ttyd", "--interface", "lo", "--port", "{port}", "--writable",
                    "--client-option", "titleFixed=Atlas terminal", atlas],
        "timeout": 30,
        "launcher_entry": {"title": "Atlas terminal"},
    },
    "atlas-resolution": {
        "command": [atlas, "serve", "--port", "{port}"],
        "timeout": 30,
        "rewrite_response": relative_resolution_urls,
        "launcher_entry": {"title": "Atlas resolution suite"},
    },
}

# A Codespaces port may forward the browser's public Host header. Jupyter
# still authenticates requests and each codespace owns its private port.
if os.environ.get("CODESPACES") == "true":
    config.ServerApp.allow_remote_access = True
