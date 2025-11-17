#!/usr/bin/env python3
"""Simple GPT probe to verify OpenAI connectivity inside Vercel."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

try:
    from openai import OpenAI
except Exception as exc:  # pragma: no cover - dependency guard
    raise SystemExit("openai package is required. Install with `pip install openai`.") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send a trivial prompt to OpenAI for health checking.")
    parser.add_argument("--model", default=os.getenv("PORT_CONVO_MODEL", "gpt-5-nano"), help="OpenAI model to use.")
    parser.add_argument("--prompt", default="Reply with the word 'READY'.", help="Prompt to send to the model.")
    return parser.parse_args()


def main() -> int:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not set.")

    args = parse_args()
    try:
        client = OpenAI()
        # Warm-up ping to verify auth/model availability.
        health_prompt = "Health check: reply with READY."
        health_response = client.responses.create(model=os.getenv("GPT_PROBE_HEALTH_MODEL", "gpt-4o-mini"), input=health_prompt)
        health_payload = json.loads(health_response.model_dump_json())
        health_text = health_payload.get("output", [{}])[0].get("content", [{}])[0].get("text", "") if health_payload.get("output") else ""

        response = client.responses.create(model=args.model, input=args.prompt)
        raw_json = json.loads(response.model_dump_json())
        output_text = raw_json.get("output", [{}])[0].get("content", [{}])[0].get("text", "") if raw_json.get("output") else ""
        payload = {
            "api_key_present": bool(api_key),
            "health_check": {
                "model": os.getenv("GPT_PROBE_HEALTH_MODEL", "gpt-4o-mini"),
                "prompt": health_prompt,
                "output_text": health_text,
                "raw": health_payload,
            },
            "prompt_check": {
                "model": args.model,
                "prompt": args.prompt,
                "output_text": output_text,
                "raw": raw_json,
            }
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover
        print("GPT probe failed:", exc, file=sys.stderr)
        traceback.print_exc()
        raise


if __name__ == "__main__":
    raise SystemExit(main())
