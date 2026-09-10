#!/usr/bin/env python3
"""Dummy-token fingerprint for production moov-recipient-session."""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

ANON = os.environ.get("ANON_KEY") or ""
if not ANON:
    text = Path(".env.production").read_text()
    match = re.search(r"VITE_SUPABASE_PUBLISHABLE_KEY=(.+)", text)
    ANON = match.group(1).strip() if match else ""
if not ANON:
    raise SystemExit("missing anon/publishable key for fingerprint")

BASE = "https://nbcqwpysqgyxrrbgtmkw.supabase.co/functions/v1"


def post(fn: str, body: dict, extra_headers: dict | None = None) -> tuple[int, dict, dict]:
    headers = {
        "Content-Type": "application/json",
        "apikey": ANON,
        "Authorization": f"Bearer {ANON}",
        "Origin": "https://checksops.com",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(
        f"{BASE}/{fn}",
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode()), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return exc.code, payload, dict(exc.headers)


failures: list[str] = []

session_code, session_body, session_headers = post("moov-recipient-session", {"token": "x"})
print("session dummy", session_code, session_body)
if session_code == 401:
    failures.append("session JWT unexpectedly enabled")
if session_body.get("error") != "This link is not valid.":
    failures.append(f"session unexpected: {session_body}")
if "failure_stage" in session_body:
    failures.append("dummy dummy body leaked classify fields")
if session_headers.get("x-checksops-moov-classify"):
    failures.append("dummy dummy leaked classify header without operator flag")

op_code, op_body, op_headers = post(
    "moov-recipient-session",
    {"token": "x"},
    {"x-checksops-operator-classify": "1"},
)
print("session dummy operator", op_code, op_body)
if op_body.get("error") != "This link is not valid.":
    failures.append(f"operator dummy unexpected: {op_body}")
if "failure_stage" in op_body:
    failures.append("operator dummy body leaked classify fields")

if failures:
    raise SystemExit("fingerprint failures: " + "; ".join(failures))
print("M6.2N dummy session fingerprints OK")
