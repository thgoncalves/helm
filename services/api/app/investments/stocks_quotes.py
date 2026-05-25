"""Yahoo Finance client with a local cache layer.

Two endpoints cover everything we need, both keyless and free:

* ``GET /v8/finance/chart/{sym}?interval=1d&range=1d``  current quote
* ``GET /v8/finance/chart/{sym}?interval=1d&range=1y``  daily closes
* ``GET /v1/finance/search?q=...``                       typeahead

User-facing tickers use the ``SYMBOL:CODE`` Bloomberg syntax
(``PFE:CA``, ``AAPL:NASDAQ``, plain ``AAPL``). ``_to_yahoo_symbols``
translates the colon syntax to one or more Yahoo suffixed forms
(``PFE.NE``, ``PFE.TO``); the upstream fetchers iterate the candidates
and accept the first non-404. The cache layer is keyed on the original
user ticker, so this translation is invisible to the rest of the app.

Errors map to the same shape the router uses regardless of provider —
``TickerNotFound`` for unknown symbols, ``QuoteRateLimited`` for 429s,
``QuoteUpstreamError`` for everything else.

Cache strategy:

* ``stock_quotes``        upsert per ticker; serve from cache if
                          ``fetched_at`` is within ``QUOTE_TTL``.
* ``stock_price_history`` upsert daily closes; refresh on first view
                          and once per ``HISTORY_REFRESH_AGE``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone, timedelta
from decimal import Decimal
from typing import Any

import httpx

from app import db

logger = logging.getLogger(__name__)

_BASE_URL = "https://query1.finance.yahoo.com"
_TIMEOUT = httpx.Timeout(10.0, read=10.0, connect=5.0)
# Yahoo returns 401/403 without a recognizable User-Agent.
_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; helm-finance/1.0)",
}

QUOTE_TTL = timedelta(minutes=15)
HISTORY_REFRESH_AGE = timedelta(hours=24)

# 2-letter user codes → ordered list of Yahoo suffixes to try. The
# ``.NE`` (Cboe Canada / NEO) entry comes first for ``CA`` because all
# the US-primary CDRs that motivated this migration (PFE, IBM, AMZN,
# …) live on NEO; ``.TO`` covers true TSX-primary listings like RY and
# BCE, picked up by the fallback when ``.NE`` 404s.
_SUFFIX_MAP: dict[str, list[str]] = {
    "US":      [""],
    "NASDAQ":  [""],
    "NYSE":    [""],
    "AMEX":    [""],
    "CA":      [".NE", ".TO"],
    "TSX":     [".TO"],
    "NEO":     [".NE"],
    "CBOE":    [".NE"],
    "BR":      [".SA"],
    "BOVESPA": [".SA"],
    "B3":      [".SA"],
    "UK":      [".L"],
    "GB":      [".L"],
    "LSE":     [".L"],
    "DE":      [".DE"],
    "FR":      [".PA"],
    "AU":      [".AX"],
    "JP":      [".T"],
    "CN":      [".SS"],
    "IN":      [".NS"],
    "MX":      [".MX"],
}

# Yahoo's chart endpoint only accepts these range strings.
_YAHOO_RANGES: list[tuple[int, str]] = [
    (1,    "1d"),
    (5,    "5d"),
    (31,   "1mo"),
    (93,   "3mo"),
    (186,  "6mo"),
    (366,  "1y"),
    (732,  "2y"),
    (1830, "5y"),
    (3660, "10y"),
]


def _to_yahoo_symbols(ticker: str) -> tuple[str, list[str]]:
    """Translate a user-facing ticker into Yahoo's suffix syntax.

    Returns ``(original_ticker, [candidate_yahoo_symbols])``.

      * ``"AAPL"``        → ``("AAPL", ["AAPL"])``
      * ``"AAPL:NASDAQ"`` → ``("AAPL:NASDAQ", ["AAPL"])``
      * ``"PFE:CA"``      → ``("PFE:CA", ["PFE.NE", "PFE.TO"])``
      * ``"RY:CA"``       → ``("RY:CA", ["RY.NE", "RY.TO"])``
      * ``"PETR4:BR"``    → ``("PETR4:BR", ["PETR4.SA"])``
      * ``"RY.TO"``       → ``("RY.TO", ["RY.TO"])``
      * ``"AAPL:XX"``     → ``("AAPL:XX", ["AAPL"])``

    The CA two-candidate ladder is the only ambiguity. Callers iterate
    the list and accept the first non-404 response.
    """
    if ":" not in ticker:
        return ticker, [ticker]
    symbol, _, code = ticker.partition(":")
    symbol = symbol.strip()
    code = code.strip().upper()
    if not symbol or not code:
        return ticker, [ticker]
    suffixes = _SUFFIX_MAP.get(code, [""])
    return ticker, [f"{symbol}{sfx}" for sfx in suffixes]


def _yahoo_range(days: int) -> str:
    """Pick the smallest Yahoo range string that covers ``days``."""
    for threshold, label in _YAHOO_RANGES:
        if days <= threshold:
            return label
    return "max"


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
    """Provider returned 429 (or its equivalent)."""

    def __init__(self) -> None:
        super().__init__(
            429,
            "Price provider is rate-limiting us. Try again shortly.",
        )


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
    try:
        response = _http().get(path, params=params or {})
    except httpx.HTTPError as e:
        raise QuoteUpstreamError(0, f"Yahoo Finance unreachable: {e}") from e
    if response.status_code == 429:
        raise QuoteRateLimited()
    if response.status_code in (401, 403):
        raise QuoteUpstreamError(
            response.status_code,
            "Yahoo Finance blocked the request — investigate User-Agent.",
        )
    if response.status_code == 404:
        # Yahoo serves 404 + JSON envelope for unknown tickers.
        raise QuoteUpstreamError(404, response.text[:200])
    if response.status_code >= 400:
        raise QuoteUpstreamError(response.status_code, response.text[:200])
    try:
        payload = response.json()
    except ValueError as e:
        raise QuoteUpstreamError(
            response.status_code, "non-JSON response"
        ) from e
    # Yahoo also signals errors inside a 200 with chart.error / finance.error.
    error = None
    if isinstance(payload, dict):
        for envelope in ("chart", "finance"):
            section = payload.get(envelope)
            if isinstance(section, dict) and section.get("error"):
                error = section["error"]
                break
    if error:
        code = str(error.get("code") or "")
        msg = str(error.get("description") or error.get("code") or "Yahoo error.")
        if code.lower() == "not found":
            raise QuoteUpstreamError(404, msg)
        raise QuoteUpstreamError(502, msg)
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


def _parse_chart_meta(meta: dict[str, Any], ticker: str) -> Quote:
    price = meta.get("regularMarketPrice")
    if price is None:
        raise TickerNotFound(ticker)
    return Quote(
        ticker=ticker,
        name=meta.get("longName") or meta.get("shortName"),
        exchange=meta.get("exchangeName"),
        currency=meta.get("currency") or "USD",
        last_price=_decimal(price),
        previous_close=_optional_decimal(meta.get("chartPreviousClose")),
        fetched_at=datetime.now(timezone.utc),
    )


def _fetch_quote_upstream(ticker: str) -> Quote:
    """Yahoo ``/v8/finance/chart/{sym}?range=1d`` — quote via chart meta.

    Iterates Yahoo candidates for the colon-syntax ticker; the cached
    row is keyed on the original ``ticker`` string so future lookups
    match exactly. Returned ``Quote.ticker`` preserves the colon form.
    """
    original, candidates = _to_yahoo_symbols(ticker)
    params = {"interval": "1d", "range": "1d"}
    last_error: QuoteUpstreamError | None = None
    for yahoo_sym in candidates:
        try:
            payload = _request(
                f"/v8/finance/chart/{yahoo_sym}", params
            )
        except QuoteUpstreamError as e:
            if e.status == 404:
                last_error = e
                continue
            raise
        result_list = (payload.get("chart") or {}).get("result") or []
        if not result_list:
            last_error = TickerNotFound(original)
            continue
        meta = result_list[0].get("meta") or {}
        try:
            return _parse_chart_meta(meta, original)
        except TickerNotFound as e:
            last_error = e
            continue
    if last_error is not None and last_error.status == 404:
        raise TickerNotFound(original) from last_error
    if last_error is not None:
        raise last_error
    raise TickerNotFound(original)


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
    ticker: str, *, days: int = 365
) -> list[HistoryPoint]:
    original, candidates = _to_yahoo_symbols(ticker)
    params = {"interval": "1d", "range": _yahoo_range(days)}
    last_error: QuoteUpstreamError | None = None
    for yahoo_sym in candidates:
        try:
            payload = _request(
                f"/v8/finance/chart/{yahoo_sym}", params
            )
        except QuoteUpstreamError as e:
            if e.status == 404:
                last_error = e
                continue
            raise
        result_list = (payload.get("chart") or {}).get("result") or []
        if not result_list:
            last_error = TickerNotFound(original)
            continue
        result = result_list[0]
        timestamps = result.get("timestamp") or []
        indicators = result.get("indicators") or {}
        quotes = indicators.get("quote") or [{}]
        closes = quotes[0].get("close") or []
        currency = (result.get("meta") or {}).get("currency") or "USD"
        out: list[HistoryPoint] = []
        for ts, close in zip(timestamps, closes):
            if close is None or ts is None:
                continue
            day = datetime.fromtimestamp(int(ts), tz=timezone.utc).date()
            out.append(
                HistoryPoint(date=day, close=_decimal(close), currency=currency)
            )
        return out
    if last_error is not None and last_error.status == 404:
        raise TickerNotFound(original) from last_error
    if last_error is not None:
        raise last_error
    return []


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
        upstream = _fetch_history_upstream(ticker, days=days)
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
    try:
        payload = _request(
            "/v1/finance/search",
            {"q": query, "quotesCount": str(limit), "newsCount": "0"},
        )
    except QuoteUpstreamError:
        # Search is best-effort; the caller renders an empty dropdown
        # rather than failing the page on a Yahoo blip.
        return []
    quotes = payload.get("quotes") or []
    out: list[SearchHit] = []
    for q in quotes[:limit]:
        symbol = q.get("symbol")
        if not symbol:
            continue
        out.append(
            SearchHit(
                ticker=symbol,
                name=q.get("longname") or q.get("shortname"),
                exchange=q.get("exchDisp") or q.get("exchange"),
                type=q.get("typeDisp") or q.get("quoteType"),
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
