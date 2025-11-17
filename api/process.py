import json
import os
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import traceback

PREPARED_TABLE = os.getenv("SUPABASE_JIRA_PREPARED_TABLE", "jira_prepared_conversations")


def count_pending_conversations() -> int | None:
    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        return None
    base = supabase_url.rstrip("/")
    endpoint = f"{base}/rest/v1/{PREPARED_TABLE}"
    params = urlencode({"select": "issue_key", "processed": "eq.false"})
    req = Request(f"{endpoint}?{params}")
    req.add_header("apikey", supabase_key)
    req.add_header("Authorization", f"Bearer {supabase_key}")
    req.add_header("Prefer", "count=exact")
    req.add_header("Range", "0-0")
    req.add_header("Accept", "application/json")
    try:
        with urlopen(req, timeout=10) as response:
            content_range = response.headers.get("Content-Range")
            if content_range and "/" in content_range:
                try:
                    return int(content_range.split("/")[-1])
                except ValueError:
                    pass
            body = response.read()
            if body:
                try:
                    data = json.loads(body.decode("utf-8"))
                    if isinstance(data, list):
                        return len(data)
                except Exception:
                    pass
    except Exception:
        traceback.print_exc()
    return None


class handler(BaseHTTPRequestHandler):
    def _respond_json(self, status_code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._respond_json(
            200,
            {"ok": True, "message": "Process endpoint ready. POST with optional JSON body {\"limit\": n}."},
        )

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", "0") or 0)
        body_bytes = self.rfile.read(content_length) if content_length else b""
        limit = 50
        model: str | None = None
        if body_bytes:
            try:
                data = json.loads(body_bytes.decode("utf-8"))
                maybe_limit = data.get("limit")
                if isinstance(maybe_limit, int) and maybe_limit > 0:
                    limit = maybe_limit
                maybe_model = data.get("model")
                if isinstance(maybe_model, str) and maybe_model.strip():
                    model = maybe_model.strip()
            except Exception:
                pass

        try:
            import process_job

            stdout, stderr = process_job.run(limit=limit, model=model)
            summary = process_job.describe_success(stdout)
            pending = count_pending_conversations()
            self._respond_json(
                200,
                {
                    "ok": True,
                    "summary": summary,
                    "limit": limit,
                    "model": model or os.getenv("PORT_CONVO_MODEL") or os.getenv("PORT_CONVO_DEFAULT_MODEL"),
                    "stdout": stdout,
                    "stderr": stderr,
                    "pending": pending,
                },
            )
        except Exception:
            traceback.print_exc()
            self._respond_json(500, {"ok": False, "error": "error in process_job.run(); see logs"})
