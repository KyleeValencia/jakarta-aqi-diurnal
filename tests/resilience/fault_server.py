"""Static test server with deterministic resilience fault-injection modes."""

from argparse import ArgumentParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import time


ROOT = Path(__file__).resolve().parents[2]
SCENARIOS = ("normal", "race", "climatology-missing", "cdn-block", "osm-block")


class ResilienceHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if self.server.scenario == "cdn-block":
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "connect-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org",
            )
        elif self.server.scenario == "osm-block":
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "connect-src 'self'; img-src 'self' data:",
            )
        super().end_headers()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if self.server.scenario == "climatology-missing" and (
            path.startswith("/data/climatology_")
            or path.startswith("/data_climatology/")
        ):
            self.send_error(404, "Injected missing climatology")
            return

        if self.server.scenario == "race":
            if path.endswith("/forecast_r7_2024-02-03.json"):
                time.sleep(1.0)
            elif path.endswith("/forecast_r7_2024-02-04.json"):
                time.sleep(0.1)

        super().do_GET()


def main():
    parser = ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--scenario", choices=SCENARIOS, default="normal")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), ResilienceHandler)
    server.scenario = args.scenario
    print(f"Serving {ROOT} on http://127.0.0.1:{args.port}/ ({args.scenario})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
