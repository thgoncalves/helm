"""Twelve Data client with a local cache layer.

Single free API for everything we need:

* ``GET /quote?symbol=AAPL``         current price + name + currency + delta
* ``GET /time_series?symbol=AAPL&interval=1day&outputsize=365``
                                      daily closes for the chart
* ``GET /symbol_search?symbol=apple`` typeahead

Free tier: 800 calls/day, 8/min, no premium-tier gates on historical
data. The API key is read from either:

* ``HELM_TWELVEDATA_API_KEY`` env (local dev — pasted plain), or
* the Secrets Manager value at ``HELM_TWELVEDATA_SECRET_ARN``.

Errors map to the same shape the router uses regardless of provider —
``TickerNotFound`` for unknown symbols, ``QuoteRateLimited`` for 429s,
``QuoteUpstreamError`` for everything else.

Cache strategy mirrors what we had on Yahoo:

* ``stock_quotes``        upsert per ticker; serve from cache if
                          ``fetched_at`` is within ``QUOTE_TTL``.
* ``stock_price_history`` upsert daily closes; refresh on first view
                          and once per ``HISTORY_REFRESH_AGE``.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

import httpx
from botocore.exceptions import ClientError

from app import aws, db
from app.config import settings

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.twelvedata.com"
_TIMEOUT = httpx.Timeout(10.0, read=10.0, connect=5.0)
_HEADERS = {"Accept": "application/json"}

QUOTE_TTL = timedelta(minutes=15)
HISTORY_REFRESH_AGE = timedelta(hours=24)


class QuoteUpstreamError(RuntimeError):
    """Provider returned a non-2xx or unparseable response."""

    def __init__(self, status: int, detail: str = "") -> None:
        super().__init__(detail or f"Price API error {status}")
        self.status = status
        self.detail = detail


class TickerNotFound(QuoteUpstreamError):
    """The symbol is unknown to the provider. Surfaced to the user."""

    def __init__(self, ticker: str) -> None:
        super().__init__(404, f"Symbol '{ticker}' not found.")
        self.ticker = ticker


class QuoteRateLimited(QuoteUpstreamError):
    """Provider returned 429 (or its equivalent free-tier credit cap)."""

    def __init__(self) -> None:
        super().__init__(
            429,
            "Price provider is rate-limiting us. Try again shortly.",
        )


class QuoteApiKeyMissing(QuoteUpstreamError):
    """No HELM_TWELVEDATA_API_KEY / HELM_TWELVEDATA_SECRET_ARN configured."""

    def __init__(self) -> None:
        super().__init__(
            503,
            "Twelve Data API key is not configured. Set HELM_TWELVEDATA_API_KEY "
            "in services/api/.env (local) or HELM_TWELVEDATA_SECRET_ARN (deployed).",
        )


# ---------------------------------------------------------------------------
# API key resolution (Secrets Manager → env fallback)
# ---------------------------------------------------------------------------

_CACHED_KEY: str | None = None


def _load_api_key() -> str:
    global _CACHED_KEY
    if _CACHED_KEY:
        return _CACHED_KEY
    inline = (settings.twelvedata_api_key or "").strip()
    if inline:
        _CACHED_KEY = inline
        return inline
    arn = (settings.twelvedata_secret_arn or "").strip()
    if not arn:
        raise QuoteApiKeyMissing()
    try:
        response = aws.secretsmanager().get_secret_value(SecretId=arn)
    except ClientError as e:
        raise QuoteUpstreamError(
            500, f"Failed to load Twelve Data key from Secrets Manager: {e}"
        ) from e
    raw = response.get("SecretString") or ""
    # Allow either plain string or {"api_key": "..."} JSON.
    try:
        parsed = json.loads(raw)
        key = parsed.get("api_key") or parsed.get("key") or raw
    except (ValueError, TypeError):
        key = raw
    key = (key or "").strip()
    if not key:
        raise QuoteApiKeyMissing()
    _CACHED_KEY = key
    return key


# ---------------------------------------------------------------------------
# httpx client
# ---------------------------------------------------------------------------

_HTTPX_CLIENT: httpx.Client | None = None


def _http() -> httpx.Client:
    global _HTTPX_CLIENT
    if _HTTPX_CLIENT is None:
        _HTTPX_CLIENT = httpx.Client(
            base_url=_BASE_URL,
            timeout=_TIMEOUT,
            headers=_HEADERS,
            http2=False,
        )
    return _HTTPX_CLIENT


def _request(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    final_params = dict(params or {})
    final_params["apikey"] = _load_api_key()
    try:
        response = _http().get(path, params=final_params)
    except httpx.HTTPError as e:
        raise QuoteUpstreamError(0, f"Twelve Data unreachable: {e}") from e
    if response.status_code == 429:
        raise QuoteRateLimited()
    if response.status_code >= 400:
        raise QuoteUpstreamError(response.status_code, response.text[:200])
    try:
        payload = response.json()
    except ValueError as e:
        raise QuoteUpstreamError(
            response.status_code, "non-JSON response"
        ) from e
    # Twelve Data signals errors inside a 200 with `status: "error"`.
    if isinstance(payload, dict) and payload.get("status") == "error":
        code = int(payload.get("code") or 0)
        msg = str(payload.get("message") or "Twelve Data error.")
        if code == 429 or "credit" in msg.lower():
            raise QuoteRateLimited()
        if code == 404 or "not found" in msg.lower():
            # Caller can wrap with TickerNotFound if it has the ticker.
            raise QuoteUpstreamError(404, msg)
        raise QuoteUpstreamError(code or 502, msg)
    return payload


# ---------------------------------------------------------------------------
# Quote
# ---------------------------------------------------------------------------


@dataclass
class Quote:
    ticker: str
    name: str | None
    exchange: str | None
    currency: str
    last_price: Decimal
    previous_close: Decimal | None
    fetched_at: datetime


def _fetch_quote_upstream(ticker: str) -> Quote:
    """Twelve Data ``/quote?symbol=…`` — richer than ``/price``."""
    try:
        payload = _request("/quote", {"symbol": ticker})
    except QuoteUpstreamError as e:
        if e.status == 404:
            raise TickerNotFound(ticker) from e
        raise
    if not isinstance(payload, dict) or not payload.get("symbol"):
        raise TickerNotFound(ticker)
    return Quote(
        ticker=payload.get("symbol", ticker),
        name=payload.get("name"),
        exchange=payload.get("exchange"),
        currency=payload.get("currency") or "USD",
        last_price=_decimal(payload.get("close")),
        previous_close=_optional_decimal(payload.get("previous_close")),
        fetched_at=datetime.now(timezone.utc),
    )


def get_cached_quote(ticker: str) -> Quote | None:
    row = db.fetch_one(
        "SELECT * FROM stock_quotes WHERE ticker = :ticker",
        {"ticker": ticker},
    )
    if row is None:
        return None
    fetched_at = row["fetched_at"]
    if isinstance(fetched_at, str):
        fetched_at = datetime.fromisoformat(fetched_at)
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) - fetched_at > QUOTE_TTL:
        return None
    return Quote(
        ticker=row["ticker"],
        name=row.get("name"),
        exchange=row.get("exchange"),
        currency=row["currency"],
        last_price=_decimal(row["last_price"]),
        previous_close=_optional_decimal(row.get("previous_close")),
        fetched_at=fetched_at,
    )


def _upsert_quote(q: Quote) -> None:
    db.execute(
        """
        INSERT INTO stock_quotes
          (ticker, currency, last_price, previous_close, name, exchange, fetched_at)
        VALUES
          (:ticker, :currency, :last_price, :previous_close, :name, :exchange, :fetched_at)
        ON CONFLICT (ticker) DO UPDATE SET
          currency       = EXCLUDED.currency,
          last_price     = EXCLUDED.last_price,
          previous_close = EXCLUDED.previous_close,
          name           = EXCLUDED.name,
          exchange       = EXCLUDED.exchange,
          fetched_at     = EXCLUDED.fetched_at
        """,
        {
            "ticker": q.ticker,
            "currency": q.currency,
            "last_price": q.last_price,
            "previous_close": q.previous_close,
            "name": q.name,
            "exchange": q.exchange,
            "fetched_at": q.fetched_at,
        },
    )


def get_quote(ticker: str, *, force_refresh: bool = False) -> Quote:
    if not force_refresh:
        cached = get_cached_quote(ticker)
        if cached is not None:
            return cached
    q = _fetch_quote_upstream(ticker)
    _upsert_quote(q)
    return q


# ---------------------------------------------------------------------------
# History
# ---------------------------------------------------------------------------


@dataclass
class HistoryPoint:
    date: date
    close: Decimal
    currency: str


def _fetch_history_upstream(
    ticker: str, *, outputsize: int = 365, interval: str = "1day"
) -> list[HistoryPoint]:
    try:
        payload = _request(
            "/time_series",
            {
                "symbol": ticker,
                "interval": interval,
                "outputsize": str(outputsize),
                "order": "ASC",
            },
        )
    except QuoteUpstreamError as e:
        if e.status == 404:
            raise TickerNotFound(ticker) from e
        raise
    meta = payload.get("meta") or {}
    currency = meta.get("currency") or "USD"
    rows = payload.get("values") or []
    out: list[HistoryPoint] = []
    for row in rows:
        ds = row.get("datetime")
        close = row.get("close")
        if not ds or close is None:
            continue
        try:
            day = date.fromisoformat(ds[:10])
        except ValueError:
            continue
        out.append(
            HistoryPoint(date=day, close=_decimal(close), currency=currency)
        )
    return out


def get_history(ticker: str, *, days: int = 365) -> list[HistoryPoint]:
    cutoff = date.today() - timedelta(days=days)
    rows = db.fetch_all(
        """
        SELECT date, close, currency, fetched_at
        FROM stock_price_history
        WHERE ticker = :ticker AND date >= :cutoff
        ORDER BY date ASC
        """,
        {"ticker": ticker, "cutoff": cutoff},
    )
    fresh_enough = False
    if rows:
        latest = max(_to_date(r["date"]) for r in rows)
        fetched = max(_to_datetime(r["fetched_at"]) for r in rows)
        if (
            (date.today() - latest).days <= 3
            and datetime.now(timezone.utc) - fetched < HISTORY_REFRESH_AGE
        ):
            fresh_enough = True

    if not fresh_enough:
        upstream = _fetch_history_upstream(ticker, outputsize=days)
        if upstream:
            _upsert_history(ticker, upstream)
            rows = db.fetch_all(
                """
                SELECT date, close, currency, fetched_at
                FROM stock_price_history
                WHERE ticker = :ticker AND date >= :cutoff
                ORDER BY date ASC
                """,
                {"ticker": ticker, "cutoff": cutoff},
            )

    return [
        HistoryPoint(
            date=_to_date(r["date"]),
            close=_decimal(r["close"]),
            currency=r["currency"],
        )
        for r in rows
    ]


def _upsert_history(ticker: str, points: list[HistoryPoint]) -> None:
    now = datetime.now(timezone.utc)
    for p in points:
        db.execute(
            """
            INSERT INTO stock_price_history (ticker, date, close, currency, fetched_at)
            VALUES (:ticker, :date, :close, :currency, :fetched_at)
            ON CONFLICT (ticker, date) DO UPDATE SET
              close      = EXCLUDED.close,
              currency   = EXCLUDED.currency,
              fetched_at = EXCLUDED.fetched_at
            """,
            {
                "ticker": ticker,
                "date": p.date,
                "close": p.close,
                "currency": p.currency,
                "fetched_at": now,
            },
        )


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@dataclass
class SearchHit:
    ticker: str
    name: str | None
    exchange: str | None
    type: str | None


def search_symbols(query: str, *, limit: int = 8) -> list[SearchHit]:
    if not query.strip():
        return []
    payload = _request("/symbol_search", {"symbol": query, "outputsize": str(limit)})
    rows = payload.get("data") or []
    out: list[SearchHit] = []
    for row in rows[:limit]:
        symbol = row.get("symbol")
        if not symbol:
            continue
        out.append(
            SearchHit(
                ticker=symbol,
                name=row.get("instrument_name"),
                exchange=row.get("exchange"),
                type=row.get("instrument_type"),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decimal(value: Any) -> Decimal:
    if value is None:
        return Decimal(0)
    if isinstance(value, Decimal):
        return value
    return Decimal(str(value))


def _optional_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    return _decimal(value)


def _to_date(value: Any) -> date:
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value))


def _to_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    parsed = datetime.fromisoformat(str(value))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
