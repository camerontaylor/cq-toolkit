#!/usr/bin/env python3
"""Read-only promotion records on queue-host's private mesh address, no dispatch."""
import http.server
import json
import os
from pathlib import Path
import re
import subprocess

ROOT = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'crq/records'


class Records(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        match = re.fullmatch(r'/promotion/([A-Za-z0-9_+.-]+)', self.path)
        if not match or '..' in match[1]:
            self.send_error(404)
            return
        path = ROOT / (match[1] + '.json')
        if not path.is_file():
            self.send_error(404)
            return
        # Files contain only the tick's allow-listed promotion metadata and advice.
        data = json.loads(path.read_text())
        body = (json.dumps(data, indent=2) + '\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    address = subprocess.run(['tailscale', 'ip', '-4'], capture_output=True, text=True, check=True).stdout.strip()
    if not re.fullmatch(r'100\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}', address):
        raise RuntimeError('private mesh address required')
    http.server.ThreadingHTTPServer((address, 6778), Records).serve_forever()
