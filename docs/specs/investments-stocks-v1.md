# Investments — Stocks V1

**Status**: planning · **Branch**: `feat/investing-stocks`

## Goal

Self-managed stock tracking under Investments, split from "Funds"
(where the bank manages allocation). For each stock the user buys we
record per-purchase lots, pull a live quote + 1Y of daily closes, and
roll up position value into the existing portfolio surface.

## Decisions (locked in)

| Choice | Pick | Why |
|---|---|---|
| Price data | Yahoo Finance public endpoint via `httpx` | No package bloat (skip `yfinance`/`pandas`); same auth-less endpoints `yfinance` calls under the hood. |
| Cost basis | Per-lot rows + computed ACB | CRA requires ACB for non-registered Canadian accounts; per-lot rows future-proof for FIFO/specific-id if we ever need it. |
| Cash on buy | Auto-debit the brokerage account's `cash_balance` | Keeps cash + holdings in sync. Toggleable on the form for the "I moved cash externally" case. |
| Dividends | Minimal record-only (V1) | Punch in date/ticker/amount/withholding so tax time isn't a hunt; no auto-pull, no UI on the position page beyond a "Record dividend" affordance. Defer to V1.5. |

## Out of scope for V1

- Sell flow (separate spec — see `investments-stocks-tax-v1.md`)
- Stock splits / corporate actions
- Watchlist (stocks not owned)
- Real-time (sub-15-min) quotes
- Per-lot capital gains identification (FIFO/specific) — ACB-only

## Data model

### New table — `stock_transactions`

Per-purchase lot. Sells, splits, and dividends will all flow through
similar tables later; V1 only writes `buy` rows. Sells reserved as a
nullable shape so the spec is honest:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK → `investment_accounts` | cascade delete |
| `ticker` | text | Yahoo-style symbol (`AAPL`, `RY.TO`, `PETR4.SA`) |
| `transaction_type` | varchar(10) | `"buy"` in V1; reserved values: `"sell"`, `"split"`, `"dividend"` |
| `transaction_date` | date | When the trade settled (user-entered) |
| `quantity` | numeric(20,8) | Fractional supported |
| `unit_price` | numeric(15,4) | In `currency` |
| `fees` | numeric(15,2) | Per-trade commission, default 0 |
| `currency` | varchar(3) | Trade currency (USD, CAD, BRL) |
| `notes` | text | Optional |
| `created_at` / `updated_at` | timestamptz | |

Index: `(account_id, ticker, transaction_date)`.

### New table — `stock_quotes`

Single-row-per-ticker cache for the latest quote.

| Column | Type | Notes |
|---|---|---|
| `ticker` | text PK | |
| `currency` | varchar(3) | Yahoo's reported quote currency |
| `last_price` | numeric(15,4) | Most recent close or live price |
| `previous_close` | numeric(15,4) | For the daily-delta display |
| `name` | text | "Apple Inc" — shown in the page header |
| `exchange` | text | "NASDAQ", "TSX" — for the header |
| `fetched_at` | timestamptz | TTL; refresh if older than 15 min |

### New table — `stock_price_history`

1Y of daily closes per ticker for the chart. Composite PK keeps it small.

| Column | Type |
|---|---|
| `ticker` | text |
| `date` | date |
| `close` | numeric(15,4) |
| `currency` | varchar(3) |
| `fetched_at` | timestamptz |

Primary key: `(ticker, date)`. We refresh the most recent N days lazily
(every ~24h) and backfill the missing range when the user first opens
a ticker we haven't seen.

### `investment_holdings` — repurposed for stocks

For `helm_kind = 'investing_stock'`:
- `shares` and `avg_cost` are **derived** from `stock_transactions` (sum of buys; weighted-average cost). Recomputed in a trigger or on write.
- `current_price` is **derived** from `stock_quotes` (mirror at read time, no trigger).
- The row exists per (account, ticker) so existing portfolio queries don't need to change shape.

For `helm_kind = 'investing_fund'`:
- Unchanged (user-maintained balance).

### Migration

`0016_stocks_v1.sql`:

```sql
CREATE TABLE stock_transactions (…);
CREATE TABLE stock_quotes (…);
CREATE TABLE stock_price_history (…);
```

No destructive change to `investment_holdings`. The "derived" math
lives in API code, not in the DB schema.

## Backend — new module `app/investments/stocks.py`

Helpers:
- `fetch_quote(ticker)` → hit `query1.finance.yahoo.com/v7/finance/quote?symbols=…`
- `fetch_chart(ticker, range="1y")` → hit `query1.finance.yahoo.com/v8/finance/chart/{ticker}?range=1y&interval=1d`
- `refresh_quote_cache(ticker)` → upsert into `stock_quotes` if stale
- `refresh_history_cache(ticker)` → upsert missing days into `stock_price_history`
- `recompute_position(account_id, ticker)` → re-derive `investment_holdings` row from `stock_transactions`

Error mapping for Yahoo failures matches the YNAB pattern in `app.ynab.client`:
401 / non-2xx → typed `HTTPException(502, {"code": "QUOTE_UPSTREAM", …})`.

## Backend — routes

All under `/investments` (existing router).

| Method + path | Purpose |
|---|---|
| `GET /investments/stocks/search?q=AAPL` | Yahoo quote-search proxy (autocomplete) |
| `GET /investments/stocks/{ticker}` | `{ quote, history[1Y] }` — single payload for the detail page |
| `POST /investments/stocks/transactions` | Record a buy. Body: `{account_id, ticker, transaction_date, quantity, unit_price, currency, fees, notes, auto_debit_cash}`. Side-effect: upsert `investment_holdings`, debit `investment_accounts.cash_balance` when `auto_debit_cash` is true. |
| `GET /investments/stocks/transactions?account_id=…&ticker=…` | List the lots behind a position (for the "transactions" tab on the ticker page) |
| `DELETE /investments/stocks/transactions/{id}` | Remove a lot (refund cash, recompute position) |
| `POST /investments/stocks/refresh-quote/{ticker}` | Force a refresh; otherwise the GET is lazy-cached |

The existing `GET /investments/portfolio` keeps working — it reads
`investment_holdings`, which we now keep accurate via triggers.

## Frontend

### Routes

| Path | Component | Notes |
|---|---|---|
| `/investments` | `Investments` (existing) | Will gain a top-level segmented control: "Stocks" / "Funds". Defaults to Stocks. |
| `/investments/stocks/:ticker` | `StockDetail` (new) | The Google-Finance-style page |
| `/investments/stocks/buy?ticker=AAPL&account=…` | `RecordPurchase` (new) | Form route — accepts ticker + account as query params for one-tap entry |

### `StockDetail` page

Roughly matches the screenshot:

```
[logo] Apple Inc                            [+ Add to holdings]
       NASDAQ: AAPL

  310.06 USD
  +5.08 (1.66%) ↑ today

  [1D] [5D] [1M] [6M] [YTD] [1Y] [5Y] [Max]   (V1: 1M, 6M, YTD, 1Y, 5Y from cache)
  ┌──────────────────────────────────────────┐
  │     ╱╲                                    │
  │ ___╱  ╲___╱╲___                           │
  │                                           │
  └──────────────────────────────────────────┘

  Your position in this stock
  ┌─────────────────────────────────────────┐
  │ Account              Shares     ACB     │
  │ Scotia iTrade        15.00      $285.4  │
  │ TFSA                 10.00      $290.0  │
  │ ─────────                               │
  │ Total                25.00      $287.3  │
  │ Current value: $7,751.50 CAD            │
  │ Unrealized: +$566.25 (+7.9%)            │
  └─────────────────────────────────────────┘

  Recent transactions
  ┌─────────────────────────────────────────┐
  │ 2026-01-15  TFSA      Buy 10  @ $290.00 │
  │ 2025-11-22  iTrade    Buy 15  @ $285.40 │
  └─────────────────────────────────────────┘
```

Chart: Recharts `LineChart` over the `history` array from the API.

### Buy form

- Ticker (pre-filled if coming from StockDetail; otherwise typeahead)
- Account dropdown (only `helm_kind = 'investing_stock'` accounts)
- Date (default today)
- Quantity (decimal)
- Unit price (decimal, currency derived from quote / overridable)
- Fees (default 0)
- **[✓] Debit cash balance ($X.XX → $Y.YY)** — preview the post-trade cash, toggleable
- Notes
- Save → POST → invalidate `["stock", ticker]`, `["portfolio"]`, `["accounts"]`

If cash would go negative and the toggle is on, show a warning but
allow it (the user might be transferring cash in separately).

## Quote/history caching strategy

- First request for a ticker: synchronous fetch, populate both
  `stock_quotes` and the missing days in `stock_price_history`.
- Subsequent requests within 15 minutes: serve from cache.
- A nightly Lambda (or the on-demand path) refreshes quotes for every
  held ticker. Out of scope for V1 — we only refresh on user view.

## Testing

- `test_stock_transactions_router.py`: buy upserts holding, debits
  cash, double-entry math is correct, delete reverses everything.
- `test_stocks_quote_cache.py`: mock the Yahoo HTTP call, assert cache
  TTL behavior.
- Playwright e2e: ticker page renders chart, buy form auto-debits.

## Open questions parked for V1.5

- Currency mismatch on cash debit (buy AAPL in USD from a CAD cash
  account — convert at FX or block?). V1: must match.
- Splits — yfinance emits split events; ignored until we have at least
  one to handle.
- Dividends — separate `dividends` table when we get to it.
- Sell flow — see `investments-stocks-tax-v1.md`.
