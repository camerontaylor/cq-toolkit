#!/usr/bin/env python3
"""Read-only promotion records on queue-host's private mesh address, no dispatch."""
import http.server
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.parse
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from record_ids import record_id, canonical_id, legacy_record_id

ROOT = Path(os.environ.get('XDG_STATE_HOME', str(Path.home() / '.local/state'))) / 'crq/records'


class Records(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # Decode once; only canonical raw IDs or deterministic aliases are accepted.
        route = urllib.parse.unquote(self.path)
        match = re.fullmatch(r'/promotion/([A-Za-z0-9_+.-]+)', route)
        if not match or '..' in match[1]:
            self.send_error(404)
            return
        try:
            iid = canonical_id(match[1]) if '_' in match[1] else match[1]
            legacy_record_id(iid)
        except ValueError:
            self.send_error(404)
            return
        path = ROOT / (match[1] + '.json')
        if not path.is_file():
            self.send_error(404)
            return
        # Files contain only the tick's allow-listed promotion metadata and advice.
        data = json.loads(path.read_text())
        if data.get('item') != iid:
            self.send_error(404)
            return
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
