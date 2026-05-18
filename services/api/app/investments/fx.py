"""FX rate cache backed by the Bank of Canada Valet API.

V1 only needs BRL → CAD (Brazilian holdings rolled up to a CAD total
portfolio view), but the wire is general so we can add USD when Scotia
accounts hold non-CAD positions.

Strategy:

1. ``get_rate(from_ccy, to_ccy, on=None)`` checks the local ``fx_rates``
   cache for the requested date (or the latest cached row if ``on`` is
   ``None``).
2. On miss, fetch from BoC Valet (``observations/FX{from}{to}?recent=N``)
   and upsert into the cache.
3. If BoC is unreachable, fall back to the most recent cached rate
   within 7 days. Raise :class:`FxRateUnavailable` if nothing is in
   range.

BoC has no API key and no rate limit worth tuning for; the cache exists
to keep dashboard loads fast (avoid one HTTP call per holding) and to
keep the app functional during BoC outages.

Tests substitute ``_HTTPX_CLIENT`` directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import httpx

from app import db


_BASE_URL = "https://www.bankofcanada.ca/valet"
_TIMEOUT = httpx.Timeout(5.0, read=5.0, connect=3.0)

# Window we accept stale cached rates over when BoC is unreachable.
# A week covers a long weekend + a BoC outage without serving rates
# from last quarter.
_STALE_WINDOW_DAYS = 7


class FxRateUnavailable(RuntimeError):
    """Raised when no BoC rate (live or cached) is available."""


@dataclass(frozen=True)
class FxRate:
    """A point-in-time FX rate."""

    from_currency: str
    to_currency: str
    rate_date: date
    rate: Decimal


# ---------------------------------------------------------------------------
# Cached httpx client (reused across calls in Lambda warm containers)
# ---------------------------------------------------------------------------

_HTTPX_CLIENT: httpx.Client | None = None


def _http() -> httpx.Client:
    global _HTTPX_CLIENT
    if _HTTPX_CLIENT is None:
        _HTTPX_CLIENT = httpx.Client(
            base_url=_BASE_URL, timeout=_TIMEOUT, http2=False
        )
    return _HTTPX_CLIENT


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def get_rate(
    from_ccy: str,
    to_ccy: str,
    on: date | None = None,
) -> FxRate:
    """Return the FX rate, hitting the cache first.

    Args:
        from_ccy: ISO 4217, e.g. ``"BRL"``.
        to_ccy:   ISO 4217, e.g. ``"CAD"``.
        on:       Specific calendar date. When ``None``, returns the
                  most recent cached rate (or the latest BoC rate if
                  the cache is empty).
    """
    if from_ccy == to_ccy:
        return FxRate(from_ccy, to_ccy, on or date.today(), Decimal("1"))

    if on is not None:
        cached = _read_cache_exact(from_ccy, to_ccy, on)
        if cached is not None:
            return cached
        # Historical date with no exact cache hit — pull a window from
        # BoC and take the closest publishing day on or before `on`.
        try:
            historical = _fetch_for_date(from_ccy, to_ccy, on)
            _write_cache(historical)
            return historical
        except (httpx.HTTPError, ValueError, KeyError):
            # Last-resort fallback: the most recent cached row at or
            # before the target date.
            nearest = _read_cache_at_or_before(from_ccy, to_ccy, on)
            if nearest is not None:
                return nearest
            raise FxRateUnavailable(
                f"No BoC rate available for {from_ccy}→{to_ccy} on or "
                f"before {on.isoformat()}."
            )

    cached = _read_cache_latest(from_ccy, to_ccy)
    if cached is not None and _is_fresh(cached.rate_date):
        return cached

    try:
        fresh = _fetch_from_boc(from_ccy, to_ccy)
        _write_cache(fresh)
        return fresh
    except (httpx.HTTPError, ValueError, KeyError):
        # Fall back to most recent cached row within the stale window.
        latest = _read_cache_latest(from_ccy, to_ccy)
        if latest is not None and (date.today() - latest.rate_date).days <= _STALE_WINDOW_DAYS:
            return latest
        raise FxRateUnavailable(
            f"No BoC rate available for {from_ccy}→{to_ccy} "
            f"(live fetch failed; nearest cached is older than "
            f"{_STALE_WINDOW_DAYS} days)."
        )


def refresh_rate(from_ccy: str, to_ccy: str) -> FxRate:
    """Force a live BoC fetch and upsert, ignoring the cache.

    Bound to ``POST /investments/fx/refresh`` so the user can force a
    rate update from the UI.
    """
    fresh = _fetch_from_boc(from_ccy, to_ccy)
    _write_cache(fresh)
    return fresh


# ---------------------------------------------------------------------------
# BoC fetch
# ---------------------------------------------------------------------------


def _fetch_from_boc(from_ccy: str, to_ccy: str) -> FxRate:
    """Pull the latest rate from BoC Valet.

    BoC publishes pairs as ``FX{from}{to}``, e.g. ``FXBRLCAD``. Not every
    pair is offered (BoC concentrates on G20-ish currencies); BRL/CAD
    has been published continuously since 2017.
    """
    series = f"FX{from_ccy.upper()}{to_ccy.upper()}"
    resp = _http().get(
        f"/observations/{series}/json",
        params={"recent": "1"},
    )
    resp.raise_for_status()
    payload: dict[str, Any] = resp.json()

    obs_list = payload.get("observations") or []
    if not obs_list:
        raise ValueError(f"BoC returned no observations for {series}")

    obs = obs_list[-1]
    return _obs_to_rate(series, obs, from_ccy, to_ccy)


def _fetch_for_date(from_ccy: str, to_ccy: str, on: date) -> FxRate:
    """Fetch the BoC rate for a specific historical date.

    BoC only publishes on business days, so we query a 7-day window
    ending on ``on`` and take the latest observation. If ``on`` is in
    the future (clock skew, user typo), fall back to the most recent
    published rate.
    """
    series = f"FX{from_ccy.upper()}{to_ccy.upper()}"
    window_start = on - timedelta(days=7)
    resp = _http().get(
        f"/observations/{series}/json",
        params={
            "start_date": window_start.isoformat(),
            "end_date": on.isoformat(),
        },
    )
    resp.raise_for_status()
    payload: dict[str, Any] = resp.json()
    obs_list = payload.get("observations") or []
    if not obs_list:
        # BoC may not yet have published rates near `on` (future date).
        # Fall back to the latest available observation.
        return _fetch_from_boc(from_ccy, to_ccy)
    return _obs_to_rate(series, obs_list[-1], from_ccy, to_ccy)


def _obs_to_rate(
    series: str,
    obs: dict[str, Any],
    from_ccy: str,
    to_ccy: str,
) -> FxRate:
    raw_date = obs.get("d")
    raw_rate = obs.get(series, {}).get("v")
    if not raw_date or raw_rate is None:
        raise ValueError(f"BoC observation missing fields: {obs!r}")
    return FxRate(
        from_currency=from_ccy.upper(),
        to_currency=to_ccy.upper(),
        rate_date=date.fromisoformat(raw_date),
        rate=Decimal(str(raw_rate)),
    )


# ---------------------------------------------------------------------------
# Cache helpers
# ---------------------------------------------------------------------------


def _read_cache_exact(
    from_ccy: str, to_ccy: str, on: date
) -> FxRate | None:
    row = db.fetch_one(
        """
        SELECT from_currency, to_currency, rate_date, rate
        FROM fx_rates
        WHERE from_currency = :from AND to_currency = :to AND rate_date = :on
        """,
        {"from": from_ccy.upper(), "to": to_ccy.upper(), "on": on},
    )
    return _row_to_rate(row) if row else None


def _read_cache_at_or_before(
    from_ccy: str, to_ccy: str, on: date
) -> FxRate | None:
    """Most recent cached rate ON OR BEFORE the target date.

    Used as a last-resort fallback when BoC is unreachable and we're
    looking up a historical rate.
    """
    row = db.fetch_one(
        """
        SELECT from_currency, to_currency, rate_date, rate
        FROM fx_rates
        WHERE from_currency = :from AND to_currency = :to
          AND rate_date <= :on
        ORDER BY rate_date DESC
        LIMIT 1
        """,
        {"from": from_ccy.upper(), "to": to_ccy.upper(), "on": on},
    )
    return _row_to_rate(row) if row else None


def _read_cache_latest(
    from_ccy: str, to_ccy: str
) -> FxRate | None:
    row = db.fetch_one(
        """
        SELECT from_currency, to_currency, rate_date, rate
        FROM fx_rates
        WHERE from_currency = :from AND to_currency = :to
        ORDER BY rate_date DESC
        LIMIT 1
        """,
        {"from": from_ccy.upper(), "to": to_ccy.upper()},
    )
    return _row_to_rate(row) if row else None


def _write_cache(rate: FxRate) -> None:
    db.execute(
        """
        INSERT INTO fx_rates
            (from_currency, to_currency, rate_date, rate, source, fetched_at)
        VALUES
            (:from, :to, :on, :rate, 'BoC', :now)
        ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE SET
            rate = EXCLUDED.rate,
            fetched_at = EXCLUDED.fetched_at
        """,
        {
            "from": rate.from_currency,
            "to": rate.to_currency,
            "on": rate.rate_date,
            "rate": rate.rate,
            "now": datetime.now(timezone.utc),
        },
    )


def _row_to_rate(row: dict[str, Any]) -> FxRate:
    return FxRate(
        from_currency=str(row["from_currency"]),
        to_currency=str(row["to_currency"]),
        rate_date=row["rate_date"],
        rate=Decimal(str(row["rate"])),
    )


def _is_fresh(rate_date: date) -> bool:
    """`True` if a cached rate is fresh enough to skip the live fetch."""
    # BoC publishes once per business day; weekends + holidays return
    # the prior business day's rate. We consider anything within
    # 3 calendar days "fresh" so a Saturday lookup doesn't hammer BoC.
    return (date.today() - rate_date).days <= 3


# Suppress unused-import warning for timedelta — kept exported in case
# downstream callers want it; currently only used in the docstring.
_ = timedelta
