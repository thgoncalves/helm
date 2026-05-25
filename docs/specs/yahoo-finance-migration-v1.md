# Yahoo Finance Migration (V1)

Migrate the stock-quote provider in `services/api` from Twelve Data
(`api.twelvedata.com`) to Yahoo Finance (`query1.finance.yahoo.com`)
while preserving the existing `Quote` / `HistoryPoint` / `SearchHit`
dataclass shapes, cache schema, router contracts, and the user-facing
`SYMBOL:CODE` ticker syntax.

The motivation is that Twelve Data's free tier paywalls many Canadian
Depositary Receipts (e.g. `PFE:CA`, `IBM:CA` on NEO/TSX) with the
message *"This symbol is available starting with the Grow or Venture
plan."* Yahoo's `/v8/finance/chart` endpoint serves them for free with
no key.

## Public-facing behavior

**No change** for the user:

- `SYMBOL:CODE` syntax (`PFE:CA`, `AAPL:NASDAQ`, plain `AAPL`) stays as
  the canonical user input. Translation to Yahoo suffixes happens
  inside the client only.
- 15-minute quote TTL and 24-hour history refresh window stay the same.
- HTTP error codes (`TICKER_NOT_FOUND` 404, `QUOTE_RATE_LIMITED` 503,
  `QUOTE_UPSTREAM` 502) are unchanged.
- Search response shape, refresh button, dashboard snapshot row — all
  visually identical.

**Changes:**

- Canadian CDRs (PFE, IBM, AMZN, etc.) start returning real quotes
  instead of `TICKER_NOT_FOUND`.
- `QUOTE_API_KEY_MISSING` 503 disappears (Yahoo needs no key).
- Research footer reads "Prices via Yahoo Finance" instead of
  "Twelve Data".

## Architecture

```
┌──────────────┐        ┌─────────────────────────┐        ┌────────────┐
│ FastAPI      │  HTTPS │ query1.finance.yahoo.com │        │ Postgres   │
│ /investments │───────▶│ /v8/finance/chart/{sym}  │        │ stock_     │
│   /stocks    │        │ /v1/finance/search       │        │   quotes   │
│   /research  │        └─────────────────────────┘        │ stock_     │
│   /snapshots │                                            │   price_   │
└──────┬───────┘                                            │   history  │
       │ TTL hit                                            └─────▲──────┘
       │ (15min quote / 24h history)                              │
       └──────────────────────────────────────────────────────────┘
```

No new infra. Drop the Secrets Manager resource that holds the Twelve
Data API key — Yahoo is keyless.

## Symbol translation

`_to_yahoo_symbols(ticker)` returns the **original** user ticker plus an
ordered list of Yahoo-form candidates. The fetcher iterates the list
and accepts the first non-404 response. The cache layer is keyed on the
original ticker, not the Yahoo form.

| User input    | Yahoo candidates  | Notes                          |
| ------------- | ----------------- | ------------------------------ |
| `AAPL`        | `[AAPL]`          | bare symbol, no suffix         |
| `AAPL:NASDAQ` | `[AAPL]`          | US exchanges → bare            |
| `PFE:CA`      | `[PFE.NE, PFE.TO]`| .NE first (Cboe CA / CDRs)     |
| `RY:CA`       | `[RY.NE, RY.TO]`  | .NE 404s; falls through to .TO |
| `PETR4:BR`    | `[PETR4.SA]`      | B3                             |
| `RY.TO`       | `[RY.TO]`         | passthrough                    |
| `AAPL:XX`     | `[AAPL]`          | unknown code → bare            |

Suffix map:

```python
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
```

## Upstream calls

### Quote — `GET /v8/finance/chart/{sym}?interval=1d&range=1d`

Parse `chart.result[0].meta`:

- `regularMarketPrice` → `last_price`
- `chartPreviousClose` → `previous_close`
- `currency` → defaults to `"USD"` if missing
- `exchangeName` → `exchange`
- `longName` or `shortName` → `name`

### History — `GET /v8/finance/chart/{sym}?interval=1d&range={1y|…}`

Yahoo accepts a fixed range vocabulary: `1d 5d 1mo 3mo 6mo 1y 2y 5y
10y ytd max`. `_yahoo_range(days)` picks the smallest range ≥ days.

Parse `chart.result[0]`:

- `meta.currency` for the series currency
- `timestamp[]` (unix seconds, ascending) zipped with
  `indicators.quote[0].close[]`
- Skip rows where `close is None` (half-day holidays)
- Use unadjusted `close`, not `adjclose`, to match what the broker
  shows for "regular market close"

### Search — `GET /v1/finance/search?q={query}&quotesCount={limit}`

Map each `quotes[].symbol` to `SearchHit`, preferring `longname` over
`shortname` and `exchDisp` over `exchange`. Filter to common quote
types if the V1 noise is excessive (defer).

### Headers

`User-Agent: Mozilla/5.0 (compatible; helm-finance/1.0)` is **mandatory**.
Yahoo returns 401/403 without a UA.

### Error mapping

- HTTP 429 → `QuoteRateLimited`
- HTTP 401/403 → `QuoteUpstreamError(403, "Yahoo blocked the request — investigate User-Agent.")`
- `chart.error.code == "Not Found"` → `TickerNotFound`
- Any other `chart.error` / `finance.error` envelope → `QuoteUpstreamError`
- `QuoteApiKeyMissing` is **deleted** — Yahoo needs no key

## Files

### `services/api/`

- `app/investments/stocks_quotes.py` — rewrite upstream layer. Keep
  `Quote`, `HistoryPoint`, `SearchHit`, `get_quote`, `get_history`,
  `search_symbols`, `get_cached_quote`, exception classes.
- `app/routers/investments_stocks.py` — drop `QuoteApiKeyMissing`
  import + branch. Docstring s/Twelve Data/Yahoo Finance.
- `app/routers/investments_research.py` — same.
- `app/config.py` — delete `twelvedata_api_key` and
  `twelvedata_secret_arn` settings.
- `.env` — delete `HELM_TWELVEDATA_API_KEY` line.
- `tests/test_stocks_quotes.py` — rewrite (shapes change). New cases
  for CA fallback ladder, ticker preservation, null-close skipping.
- `tests/test_research_router.py` — s/Twelve Data/Yahoo/ in comments.

### `infra/`

- `lib/api-stack.ts` — drop the `twelveDataSecret` resource,
  `grantRead`, and `addEnvironment('HELM_TWELVEDATA_SECRET_ARN', …)`.
  Keep the `secretsmanager` import (still used for YNAB).

### `apps/web/`

- `routes/Stocks.tsx` — placeholder text:
  `"e.g. AAPL, RY:CA, PFE:CA, RY.TO"`.
- `routes/RecordPurchase.tsx` — same placeholder pattern.
- `routes/Research.tsx` — footer: `"Prices via Yahoo Finance, cached for 24h on this view."`

## Deployment

1. Branch off `dev`: `feat/yahoo-finance-migration`.
2. Implement; `pytest services/api/tests/test_stocks_quotes.py
   tests/test_research_router.py`.
3. Smoke locally against Yahoo for `PFE:CA`, `IBM:CA`, `AAPL`, `RY:CA`
   (quote + history).
4. Push branch → Amplify sandbox preview builds.
5. `npx cdk deploy helm-api-dev -c userPoolClientId=4ruesl329oslgarccfh2qa6k6o`.
6. UI verify on dev: add `PFE:CA`, `IBM:CA`, `AAPL`; refresh research
   quote; load history chart.
7. Merge to `main`.
8. `npx cdk deploy helm-api-main -c env=main -c userPoolClientId=4srae6rkc0o1paikd3e2117oq5`.
9. Follow-up commit: delete `helm/dev/twelvedata/api-key` and
   `helm/main/twelvedata/api-key` from Secrets Manager (7-day recovery
   window).

## Rollback

`git revert` migration commit, redeploy both Lambdas with the same
`-c userPoolClientId=…` flags. CDK re-creates the
`TwelveDataApiKey` Secrets Manager resource — re-seed the key from
where it lives (1Password / `.env` backup). Cache rows from the Yahoo
era are still valid (same schema). CDRs start 404'ing again, the
pre-migration state.

## Risks

- **Lambda IP rate limiting.** Yahoo's anonymous quote endpoint allows
  ~100 req/min/IP, shared across warm Lambda instances in
  `ca-central-1`. Existing 15min / 24h caches should keep us well
  under. Only mitigate on real signal.
- **Yahoo bot-blocking.** If `/v8` ever starts returning 401/403,
  rotating the `User-Agent` is the first step; the cookie+crumb
  `/v7/finance/quote` endpoint is the documented contingency, not
  pre-built.
- **CA fallback correctness.** `.NE` first picks the CDR for
  US-primary names (PFE, IBM); `.TO` covers TSX-primary names
  (RY, BCE). For ambiguous names where both exist, users can force
  `:TSX` or `:NEO` explicitly.
- **Search returns Yahoo-suffixed symbols.** Picking `AAPL.NE` from
  the dropdown stores `AAPL.NE` (passthrough), not `AAPL:CA`. The two
  forms don't aggregate together on the positions page — cosmetic for
  V1, future ticker-normalization issue if it bites.

## Out of scope

- Cache schema changes
- Router HTTP contract changes
- Frontend symbol-input UX changes beyond placeholder copy
- Pre-emptive crumb/cookie support for `/v7`
