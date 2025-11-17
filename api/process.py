import json
import os
import subprocess
from datetime import datetime

PYTHON_BIN = os.getenv("PYTHON_BIN", "python3")
PROCESS_SCRIPT = os.path.join(os.getcwd(), "jiraPull", "process_conversations.py")


def handler(request):
    if request.method != "POST":
        return {
            "statusCode": 405,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": "Method not allowed"})
        }

    supabase_url = os.getenv("SUPABASE_URL") or os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    jira_base = os.getenv("JIRA_BASE_URL") or os.getenv("JIRA_BASEURL") or os.getenv("JIRA_URL")
    jira_user = os.getenv("JIRA_USERNAME") or os.getenv("JIRA_EMAIL")
    jira_token = os.getenv("JIRA_API_TOKEN") or os.getenv("JIRA_TOKEN")

    missing: list[str] = []
    if not supabase_url:
        missing.append("SUPABASE_URL")
    if not supabase_key:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if not jira_base:
        missing.append("JIRA_BASE_URL")
    if not jira_user:
        missing.append("JIRA_USERNAME")
    if not jira_token:
        missing.append("JIRA_API_TOKEN")

    if missing:
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": f"Missing credentials: {', '.join(missing)}"`

    limit = request.body.get("limit") if hasattr(request, "body") else None
    if not limit:
        limit = "50"

    try:
        env = {
            **os.environ,
            "SUPABASE_URL": supabase_url,
            "SUPABASE_SERVICE_ROLE_KEY": supabase_key,
            "JIRA_BASE_URL": jira_base,
            "JIRA_USERNAME": jira_user,
            "JIRA_API_TOKEN": jira_token,
            "PYTHONUNBUFFERED": "1"
        }
        completed = subprocess.run(
            [PYTHON_BIN, PROCESS_SCRIPT, "--limit", str(limit)],
            check=True,
            capture_output=False,
            text=True,
            env=env
        )
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "ok": True,
                "exitCode": completed.returncode,
                "finishedAt": datetime.utcnow().isoformat()
            })
        }
    except subprocess.CalledProcessError as exc:
        error_text = str(exc)
        print("[process error exit]", error_text)
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "error": error_text,
                "exitCode": exc.returncode
            })
        }
    except Exception as exc:  # pylint: disable=broad-except
        print("[process exception]", repr(exc))
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({
                "error": str(exc),
                "stdout": None,
                "stderr": None
            })
        }
