"""DecisionProvider interface + implementations.

  ClefProvider  Cloudflare Workers AI Clef over REST (images supported, ≤4)
  MockProvider  deterministic answers for tests / offline runs
Selected by name ("clef" | "clef-flash" | "mock"); "jev" arrives in stretch S3.

Every call is appended to data/<id>/decisions.jsonl by the caller (see judge.py / practice).
"""

from __future__ import annotations

import asyncio
import base64
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx

CLEF_MODELS = {"clef", "clef-flash"}
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_REQUEST_BYTES = 13 * 1024 * 1024

Questions = dict[str, dict[str, Any]]
Answers = dict[str, dict[str, Any]]


class ProviderError(RuntimeError):
    pass


@dataclass
class Decision:
    answers: Answers
    provider: str
    model: str
    latency_ms: float
    usage: dict = field(default_factory=dict)


class DecisionProvider:
    name = "base"
    model = ""
    supports_images = False

    async def evaluate(self, state: Any, questions: Questions, images: list[Path] | None = None) -> Decision:
        raise NotImplementedError

    async def aclose(self) -> None:
        pass


def image_data_url(path: Path) -> str:
    data = path.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise ProviderError(f"{path.name} is {len(data)} bytes (> 4 MiB)")
    return "data:image/jpeg;base64," + base64.b64encode(data).decode()


def parse_clef_response(body: dict, questions: Questions) -> tuple[Answers, dict]:
    """REST envelope → answers. Validates every asked question came back with the expected type."""
    try:
        return _parse_clef_response(body, questions)
    except (KeyError, TypeError, ValueError) as e:
        raise ProviderError(f"malformed Clef response: {e!r}") from e


def _parse_clef_response(body: dict, questions: Questions) -> tuple[Answers, dict]:
    if not isinstance(body, dict):
        raise ProviderError("response is not a JSON object")
    if body.get("success") is False:
        raise ProviderError(f"Clef error: {body.get('errors')}")
    result = body.get("result", body)  # binding-style responses have no envelope
    answers = result.get("answers")
    if not isinstance(answers, dict):
        raise ProviderError("no answers in response")
    out: Answers = {}
    for name, q in questions.items():
        a = answers.get(name)
        if not isinstance(a, dict):
            raise ProviderError(f"missing answer for {name!r}")
        typ = q["type"]
        if a.get("type", typ) != typ:
            raise ProviderError(f"{name!r}: expected {typ}, got {a.get('type')}")
        if typ == "noul":
            p = float(a["noul"])
            if not 0.0 <= p <= 1.0:
                raise ProviderError(f"{name!r}: noul out of range: {p}")
            out[name] = {"type": "noul", "noul": p}
        elif typ == "choice":
            out[name] = {
                "type": "choice",
                "choice": a["choice"],
                "probabilities": {k: float(v) for k, v in (a.get("probabilities") or {}).items()},
                "confidence": float(a.get("confidence", 0.0)),
            }
        elif typ == "score":
            out[name] = {
                "type": "score",
                "score": float(a["score"]),
                "legend": a.get("legend") or {},
                "probabilities": {str(k): float(v) for k, v in (a.get("probabilities") or {}).items()},
                "confidence": float(a.get("confidence", 0.0)),
            }
        else:
            raise ProviderError(f"unknown question type {typ!r}")
    return out, result.get("usage") or {}


class ClefProvider(DecisionProvider):
    supports_images = True

    def __init__(self, model: str = "clef", *, account_id: str | None = None, api_token: str | None = None,
                 client: httpx.AsyncClient | None = None, max_retries: int = 2, timeout_s: float = 60.0):
        if model not in CLEF_MODELS:
            raise ValueError(f"Clef model must be one of {sorted(CLEF_MODELS)}, got {model!r}")
        self.name = "clef"
        self.model = model
        self.account_id = account_id or os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        self.api_token = api_token or os.environ.get("CLOUDFLARE_API_TOKEN", "")
        if not self.account_id or not self.api_token:
            raise ProviderError("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set")
        self._client = client or httpx.AsyncClient(timeout=timeout_s)
        self._own_client = client is None
        self.max_retries = max_retries

    @property
    def url(self) -> str:
        return f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/ai/run/@cf/cloudflare/{self.model}"

    def build_body(self, state: Any, questions: Questions, images: list[Path] | None) -> dict:
        body: dict[str, Any] = {"model": self.model, "state": state, "questions": questions}
        if images:
            if len(images) > MAX_IMAGES:
                raise ProviderError(f"at most {MAX_IMAGES} images")
            body["images"] = [image_data_url(p) for p in images]
        return body

    async def evaluate(self, state: Any, questions: Questions, images: list[Path] | None = None) -> Decision:
        body = self.build_body(state, questions, images)
        size = sum(len(u) for u in body.get("images", [])) + len(str(state)) + len(str(questions))
        if size > MAX_REQUEST_BYTES:
            raise ProviderError(f"request too large ({size} bytes)")
        headers = {"Authorization": f"Bearer {self.api_token}"}
        t0 = time.perf_counter()
        last_err: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                r = await self._client.post(self.url, json=body, headers=headers)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < self.max_retries:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
                if r.status_code >= 400:
                    raise ProviderError(f"HTTP {r.status_code}: {r.text[:300]}")
                answers, usage = parse_clef_response(r.json(), questions)
                return Decision(answers, "clef", self.model, round((time.perf_counter() - t0) * 1000, 1), usage)
            except (httpx.TransportError, ValueError) as e:
                last_err = e
                if attempt < self.max_retries:
                    await asyncio.sleep(1.5 * (attempt + 1))
                    continue
        raise ProviderError(f"Clef request failed: {last_err}")

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()


class MockProvider(DecisionProvider):
    """Answers via a function(state, questions) → answers; default = confident 'keep everything'."""

    supports_images = True

    def __init__(self, fn: Callable[[Any, Questions], Answers] | None = None, model: str = "mock"):
        self.name = "mock"
        self.model = model
        self.fn = fn or default_mock_answers
        self.calls: list[dict] = []

    async def evaluate(self, state: Any, questions: Questions, images: list[Path] | None = None) -> Decision:
        self.calls.append({"state": state, "questions": questions, "images": [str(p) for p in images or []]})
        return Decision(self.fn(state, questions), "mock", self.model, 0.0, {})


def default_mock_answers(state: Any, questions: Questions) -> Answers:
    out: Answers = {}
    for name, q in questions.items():
        if q["type"] == "noul":
            out[name] = {"type": "noul", "noul": 0.9 if name == "meaningful" else 0.1}
        elif q["type"] == "choice":
            opts = list(q["criteria"].keys())
            out[name] = {"type": "choice", "choice": opts[0], "probabilities": {o: (1.0 if i == 0 else 0.0) for i, o in enumerate(opts)}, "confidence": 1.0}
        else:
            n = len(q["criteria"])
            out[name] = {"type": "score", "score": float(n - 1), "legend": {}, "probabilities": {str(n - 1): 1.0}, "confidence": 1.0}
    return out


def get_provider(name: str) -> DecisionProvider:
    if name in CLEF_MODELS:
        return ClefProvider(name)
    if name == "mock":
        return MockProvider()
    if name == "jev":
        raise ProviderError("JevProvider arrives in stretch S3")
    raise ValueError(f"unknown provider {name!r}")
