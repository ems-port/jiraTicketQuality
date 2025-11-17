import json
from http.server import BaseHTTPRequestHandler
import traceback


class handler(BaseHTTPRequestHandler):
    def _respond_json(self, status_code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond_json(200, {"ok": True, "message": "Ingest endpoint ready. Use POST to trigger the job."})

    def do_POST(self):
        try:
            import ingest_job

            stdout, stderr = ingest_job.run()
            summary = ingest_job.describe_success(stdout)
            self._respond_json(
                200,
                {
                    "ok": True,
                    "summary": summary,
                    "stdout": stdout,
                    "stderr": stderr,
                },
            )
        except Exception:
            traceback.print_exc()
            self._respond_json(500, {"ok": False, "error": "error in ingest_job.run(); see logs"})
