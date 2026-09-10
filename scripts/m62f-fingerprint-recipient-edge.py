#!/usr/bin/env python3
"""Dummy-token fingerprints for production recipient Edge Functions."""
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


def post(fn: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f"{BASE}/{fn}",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "apikey": ANON,
            "Authorization": f"Bearer {ANON}",
            "Origin": "https://checksops.com",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"raw": raw}
        return exc.code, payload


failures: list[str] = []

session_code, session_body = post("moov-recipient-session", {"token": "x"})
print("session", session_code, session_body)
if session_code == 401:
    failures.append("session JWT unexpectedly enabled")
if session_body.get("error") != "This link is not valid.":
    failures.append(f"session unexpected: {session_body}")

tos_code, tos_body = post("moov-recipient-tos-accept", {"token": "x"})
print("tos dummy", tos_code, tos_body)
if tos_body.get("error") == "Terms must be explicitly accepted.":
    failures.append("OLD ToS checkbox path still live")
if tos_body.get("error") != "tos_drop_token_required":
    failures.append(f"tos dummy unexpected: {tos_body}")

forged_code, forged_body = post("moov-recipient-tos-accept", {"token": "x", "accepted": True})
print("tos forged", forged_code, forged_body)
if forged_body.get("error") != "tos_acceptance_forged":
    failures.append(f"tos forged unexpected: {forged_body}")

drop_code, drop_body = post(
    "moov-recipient-tos-accept",
    {"token": "x", "terms_of_service_token": "faketokenvalue"},
)
print("tos fake drop", drop_code, drop_body)
if drop_body.get("error") == "Terms must be explicitly accepted.":
    failures.append("OLD ToS checkbox path still live for drop token body")
if drop_body.get("error") != "This link is not valid.":
    failures.append(f"tos fake drop unexpected: {drop_body}")

kyc_code, kyc_body = post(
    "moov-recipient-kyc-update",
    {
        "token": "x",
        "first_name": "Test",
        "last_name": "User",
        "email": "test@example.com",
        "phone": "5555555555",
        "address_line1": "1 Main St",
        "city": "Boston",
        "state": "MA",
        "postal_code": "02101",
        "birth_date": "1990-01-01",
        "ssn": "123456789",
    },
)
print("kyc dummy complete", kyc_code, kyc_body)
if kyc_code == 401:
    failures.append("kyc JWT unexpectedly enabled")
if kyc_body.get("error") != "This link is not valid.":
    failures.append(f"kyc dummy unexpected: {kyc_body}")

bank_code, bank_body = post("moov-recipient-bank-verify", {"token": "x"})
print("bank-verify no action", bank_code, bank_body)
if bank_body.get("message") == "Requested function was not found" or (
    bank_code == 404 and bank_body.get("code") == "NOT_FOUND"
):
    failures.append("bank-verify still missing")
if bank_body.get("error") != "action must be initiate or confirm.":
    failures.append(f"bank-verify no-action unexpected: {bank_body}")

bank2_code, bank2_body = post("moov-recipient-bank-verify", {"token": "x", "action": "initiate"})
print("bank-verify initiate dummy", bank2_code, bank2_body)
if bank2_body.get("error") != "This link is not valid.":
    failures.append(f"bank-verify initiate unexpected: {bank2_body}")

if failures:
    raise SystemExit("fingerprint failures: " + "; ".join(failures))
print("M6.2F live fingerprints OK")
