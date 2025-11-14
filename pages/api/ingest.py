import json
import os
import subprocess
from datetime import datetime

PYTHON_BIN = os.getenv("PYTHON_BIN", "python3")
INGEST_SCRIPT = os.path.join(os.getcwd(), "jiraPull", "injestionJiraTickes.py")


def handler(request):
    if request.method != "POST":
        return {
            "statusCode": 405,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": "Method not allowed"})
        }

    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

    if not supabase_url or not supabase_key:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": "Missing Supabase credentials"})
        }

    try:
        result = subprocess.run(
            [PYTHON_BIN, INGEST_SCRIPT],
            check=True,
            capture_output=True,
            text=True,
            env={**os.environ,
                 "SUPABASE_URL": supabase_url,
                 "SUPABASE_SERVICE_ROLE_KEY": supabase_key}
        )
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "ok": True,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "finishedAt": datetime.utcnow().isoformat()
            })
        }
    except subprocess.CalledProcessError as exc:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "error": exc.stderr or str(exc),
                "stdout": exc.stdout,
                "stderr": exc.stderr
            })
        }
