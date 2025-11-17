#!/usr/bin/env python3
"""Simple GPT probe to verify OpenAI connectivity inside Vercel."""

from __future__ import annotations

import argparse
import json
import os
import sys

try:
    from openai import OpenAI
except Exception as exc:  # pragma: no cover - dependency guard
    raise SystemExit("openai package is required. Install with `pip install openai`." ) from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send a trivial prompt to OpenAI for health checking.")
    parser.add_argument("--model", default=os.getenv("PORT_CONVO_MODEL", "gpt-5-nano"), help="OpenAI model to use.")
    parser.add_argument("--prompt", default="Reply with the word 'READY'.", help="Prompt to send to the model.")
    return parser.parse_args()


def main() -> int:
    if not os.getenv("OPENAI_API_KEY"):
        raise SystemExit("OPENAI_API_KEY is not set.")

    args = parse_args()
    client = OpenAI()
    response = client.responses.create(model=args.model, input=args.prompt)
    raw_json = json.loads(response.model_dump_json())
    output_text = response.output[0].get("content", [{}])[0].get("text", "") if response.output else ""
    payload = {
        "model": args.model,
        "prompt": args.prompt,
        "output_text": output_text,
        "raw": raw_json,
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
