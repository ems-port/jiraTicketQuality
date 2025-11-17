#!/usr/bin/env python3
"""Simple GPT probe to verify OpenAI connectivity inside Vercel."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from typing import Any, Dict, List

try:  # Python 3.8 compatibility
    from importlib import metadata as importlib_metadata
except ImportError:  # pragma: no cover - fallback for older runtimes
    import importlib_metadata  # type: ignore

try:
    from openai import OpenAI
except Exception as exc:  # pragma: no cover - dependency guard
    raise SystemExit("openai package is required. Install with `pip install openai`.") from exc


DEFAULT_PAIR_MODELS = ["gpt-4o-mini", "gpt-5-nano"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Send a trivial prompt to OpenAI for health checking.")
    parser.add_argument("--model", default=os.getenv("PORT_CONVO_MODEL", "gpt-5-nano"), help="OpenAI model to use.")
    parser.add_argument("--prompt", default="Reply with the word 'READY'.", help="Prompt to send to the model.")
    parser.add_argument(
        "--compare-models",
        nargs="*",
        default=DEFAULT_PAIR_MODELS,
        metavar="MODEL",
        help="Optional list of models to compare back-to-back for structural diffs.",
    )
    return parser.parse_args()


def runtime_snapshot() -> Dict[str, Any]:
    info: Dict[str, Any] = {
        "python_version": sys.version,
        "python_executable": sys.executable,
        "env_vars": {
            "PORT_CONVO_MODEL": os.getenv("PORT_CONVO_MODEL"),
            "GPT_PROBE_HEALTH_MODEL": os.getenv("GPT_PROBE_HEALTH_MODEL"),
        },
    }
    try:
        import openai  # type: ignore

        info["openai_module_version"] = getattr(openai, "__version__", "unknown")
        info["openai_module_path"] = getattr(openai, "__file__", "unknown")
    except Exception as exc:  # pragma: no cover - diagnostics
        info["openai_import_error"] = str(exc)
    try:
        info["openai_dist_version"] = importlib_metadata.version("openai")
    except Exception:
        info["openai_dist_version"] = "unknown"
    return info


def _dump_response(response: Any) -> Dict[str, Any]:
    if response is None:  # pragma: no cover - guard
        return {}
    for attr in ("model_dump_json", "json"):
        serializer = getattr(response, attr, None)
        if callable(serializer):
            try:
                return json.loads(serializer())
            except Exception:
                continue
    model_dump = getattr(response, "model_dump", None)
    if callable(model_dump):
        try:
            data = model_dump()
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    if isinstance(response, dict):
        return response
    return {"unserializable_response": repr(response)}


def _collect_text_from_output(output: Any) -> List[str]:
    texts: List[str] = []
    if not isinstance(output, list):
        return texts
    for block in output:
        if not isinstance(block, dict):
            continue
        content = block.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict):
                    text_value = item.get("text") or item.get("value")
                    if isinstance(text_value, str) and text_value.strip():
                        texts.append(text_value.strip())
    return texts


def extract_text_from_payload(payload: Dict[str, Any]) -> tuple[str, Dict[str, Any]]:
    if not isinstance(payload, dict):
        return "", {"strategy": "payload_not_dict"}
    for key in ("output", "outputs", "data"):
        texts = _collect_text_from_output(payload.get(key))
        if texts:
            return "\n".join(texts), {"strategy": f"{key}_blocks", "chunks": len(texts)}
    choices = payload.get("choices")
    if isinstance(choices, list):
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, list):
                    texts = []
                    for item in content:
                        if isinstance(item, dict):
                            text_value = item.get("text") or item.get("value")
                            if isinstance(text_value, str) and text_value.strip():
                                texts.append(text_value.strip())
                    if texts:
                        return "\n".join(texts), {"strategy": "chat_message_list", "chunks": len(texts)}
                elif isinstance(content, str) and content.strip():
                    return content.strip(), {"strategy": "chat_message_str", "chunks": 1}
            text_fallback = choice.get("text")
            if isinstance(text_fallback, str) and text_fallback.strip():
                return text_fallback.strip(), {"strategy": "choice_text", "chunks": 1}
    content_value = payload.get("content")
    if isinstance(content_value, str) and content_value.strip():
        return content_value.strip(), {"strategy": "top_level_content", "chunks": 1}
    return "", {"strategy": "unmatched", "chunks": 0}


def summarize_structure(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {"type": type(payload).__name__}
    summary: Dict[str, Any] = {
        "top_level_keys": sorted(payload.keys()),
        "has_output": "output" in payload or "outputs" in payload,
        "has_choices": "choices" in payload,
    }
    if "output" in payload and isinstance(payload.get("output"), list):
        summary["output_entry_types"] = sorted({type(item).__name__ for item in payload["output"]})
    if "choices" in payload and isinstance(payload.get("choices"), list):
        summary["choices_count"] = len(payload["choices"])
    return summary


def perform_model_call(client: OpenAI, *, model: str, prompt: str) -> Dict[str, Any]:
    record: Dict[str, Any] = {"model": model, "prompt": prompt}
    errors: List[Dict[str, Any]] = []
    response_obj = None
    api_used: str | None = None
    try:
        response_obj = client.responses.create(model=model, input=prompt)
        api_used = "responses.create"
    except Exception as exc:
        errors.append({"api": "responses.create", "error": str(exc), "traceback": traceback.format_exc()})
        try:
            response_obj = client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
            )
            api_used = "chat.completions.create"
        except Exception as chat_exc:
            errors.append({"api": "chat.completions.create", "error": str(chat_exc), "traceback": traceback.format_exc()})
    if api_used:
        record["api"] = api_used
    if errors:
        record["errors"] = errors
    if response_obj is None:
        record["error"] = "All OpenAI API attempts failed"
        return record
    raw_payload = _dump_response(response_obj)
    record["raw"] = raw_payload
    record["structure"] = summarize_structure(raw_payload)
    try:
        text, meta = extract_text_from_payload(raw_payload)
        record["output_text"] = text
        record["parse_metadata"] = meta
        if not text:
            warning = "Parsed text empty; inspect raw payload for schema changes."
            record.setdefault("warnings", []).append(warning)
            print(
                f"[gpt-probe] {model} produced no parseable text via {meta.get('strategy')}\n"
                f"Raw payload: {json.dumps(raw_payload, indent=2)}",
                file=sys.stderr,
            )
    except Exception as exc:
        record["parse_error"] = str(exc)
        print(
            f"[gpt-probe] Failed to parse response from {model}: {exc}\n"
            f"Raw payload: {json.dumps(raw_payload, indent=2)}",
            file=sys.stderr,
        )
    return record


def compare_models(client: OpenAI, prompt: str, models: List[str]) -> Dict[str, Any]:
    results = [perform_model_call(client, model=model, prompt=prompt) for model in models]
    structure_summary = {entry.get("model"): entry.get("structure") for entry in results if entry.get("structure")}
    comparison: Dict[str, Any] = {"prompt": prompt, "results": results}
    if structure_summary:
        all_keys = sorted({key for summary in structure_summary.values() for key in summary.get("top_level_keys", [])})
        comparison["structure_diffs"] = {
            model: {
                "top_level_keys": summary.get("top_level_keys", []),
                "missing_keys": [key for key in all_keys if key not in summary.get("top_level_keys", [])],
            }
            for model, summary in structure_summary.items()
        }
    return comparison


def main() -> int:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise SystemExit("OPENAI_API_KEY is not set.")

    args = parse_args()
    try:
        client = OpenAI()
        health_model = os.getenv("GPT_PROBE_HEALTH_MODEL", "gpt-4o-mini")
        health_prompt = "Health check: reply with READY."
        health_check = perform_model_call(client, model=health_model, prompt=health_prompt)
        prompt_check = perform_model_call(client, model=args.model, prompt=args.prompt)
        comparison_prompt = args.prompt
        comparison = compare_models(client, prompt=comparison_prompt, models=args.compare_models)
        payload = {
            "api_key_present": bool(api_key),
            "runtime": runtime_snapshot(),
            "health_check": health_check,
            "prompt_check": prompt_check,
            "model_comparison": comparison,
        }
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover
        print("GPT probe failed:", exc, file=sys.stderr)
        traceback.print_exc()
        raise


if __name__ == "__main__":
    raise SystemExit(main())
