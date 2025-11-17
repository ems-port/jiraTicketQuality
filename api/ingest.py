from http.server import BaseHTTPRequestHandler
import traceback


class handler(BaseHTTPRequestHandler):
    def _write(self, text: str):
        self.wfile.write(text.encode("utf-8"))

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self._write("Ingest endpoint ready. Use POST to trigger the job.")

    def do_POST(self):
        self.send_response(200)
        self.end_headers()
        try:
            import ingest_job

            stdout, stderr = ingest_job.run()
            summary = ingest_job.describe_success(stdout)
            response_lines = ["ingest_job.run() executed.", summary]
            if stderr.strip():
                response_lines.append("stderr:\n" + stderr.strip())
            self._write("\n".join(response_lines))
        except Exception:
            traceback.print_exc()
            self._write("error in ingest_job.run(); see logs")
