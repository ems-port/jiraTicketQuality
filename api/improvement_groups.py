#!/usr/bin/env python3
"""
HTTP handler to trigger the improvement tip grouping job (Python-native).

This mirrors the style of api/ingest.py and api/process.py so it can run
on Vercel's Python runtime. It shells out to analysis/improvement_tip_summary_v2.py
and returns stdout/stderr for observability.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import List

DEFAULT_MAX_TOKENS = os.getenv("IMPROVEMENT_GROUP_MAX_TOKENS", "6000")


def run_job(args: List[str] | None = None) -> tuple[str, str]:
    script_path = Path(__file__).resolve().parents[1] / "analysis" / "improvement_tip_summary_v2.py"
    cmd = [sys.executable or "python3", str(script_path)]
    if args:
        cmd.extend(args)
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(Path(__file__).resolve().parents[1]),
    )
    stdout, stderr = process.communicate(timeout=180)
    if process.returncode != 0:
        raise RuntimeError(f"Job failed (exit {process.returncode})", stdout, stderr)
    return stdout, stderr


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
            {"ok": True, "message": "Improvement groups endpoint ready. POST to trigger the job."},
        )

    def do_POST(self):
        max_tokens = DEFAULT_MAX_TOKENS
        try:
            content_length = int(self.headers.get("Content-Length", "0") or 0)
            body_bytes = self.rfile.read(content_length) if content_length else b""
            if body_bytes:
                data = json.loads(body_bytes.decode("utf-8"))
                maybe_tokens = data.get("max_tokens") or data.get("maxTokens")
                if isinstance(maybe_tokens, (int, str)) and str(maybe_tokens).strip():
                    max_tokens = str(maybe_tokens).strip()
        except Exception:
            pass

        try:
            stdout, stderr = run_job(["--max-tokens", max_tokens])
            self._respond_json(
                200,
                {
                    "ok": True,
                    "max_tokens": max_tokens,
                    "stdout": stdout,
                    "stderr": stderr,
                },
            )
        except Exception as exc:
            self._respond_json(
                500,
                {
                    "ok": False,
                    "error": str(exc),
                },
            )
