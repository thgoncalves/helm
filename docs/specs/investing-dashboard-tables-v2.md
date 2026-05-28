# Investing Dashboard — split position tables, detailed stocks view, refresh buttons, button polish

## Context
The Investing Dashboard (`apps/web/src/routes/Investments.tsx`) currently shows one combined "Positions" table that interleaves manual funds, YNAB-synced funds, and a thin stocks summary, with a generic "CAD value" column. The user wants: (1) clearer labelling, (2) a proper brokerage-style stocks table, (3) each source in its own table with its own totals, (4) visibility into how stale the stock prices are, (5) one-click ways to refresh prices and re-sync YNAB, and (6) nicer-looking buttons app-wide. Today there's no way to force a price refresh from the UI and no indication of quote freshness, so the dashboard can silently show stale numbers.

Decisions locked with the user: stocks table shows **native** avg cost & market price but **CAD** for book/market value, change, and totals; "Refresh prices" **force-refreshes all** held tickers; button work is limited to **restyling the shared `Button` component only**.

## Backend

### 1. Expose quote freshness on positions
- `services/api/app/models/stocks.py` — add to `StockPortfolioRow`: `current_price_as_of: datetime | None = None` (`datetime` already imported).
- `services/api/app/routers/investments_stocks.py` `list_positions` (~308-393) — add `q.fetched_at AS quote_fetched_at` to the SELECT; seed `"quote_as_of": r.get("quote_fetched_at")` in the per-ticker agg dict; pass `current_price_as_of=agg["quote_as_of"]` when building each `StockPortfolioRow`.

### 2. Bulk price refresh endpoint
- New `POST /investments/stocks/refresh-prices` in `investments_stocks.py` near `refresh_quote` (470). Selects `DISTINCT ticker FROM stock_transactions`, force-refreshes each via the existing `get_quote(ticker, force_refresh=True)` (`app/investments/stocks_quotes.py`) using a `ThreadPoolExecutor(max_workers=min(8, n))` (get_quote is blocking httpx; `db.py` RDS Data API is thread-safe per its docstring). **Never raises on partial failure** — swallows `QuoteUpstreamError` per ticker into a summary so the UI can show "5 of 7 refreshed".
- New response model `RefreshPricesResult` in `stocks.py`: `refreshed:int, failed:int, max_fetched_at:datetime|None, errors:list[str]` (errors capped at ~5).

### 3. TS types — `apps/web/src/types/api.ts`
- `StockPortfolioRow`: add `current_price_as_of: string | null;`
- Add `RefreshPricesResult { refreshed; failed; max_fetched_at: string|null; errors: string[] }`.

## Frontend — `apps/web/src/routes/Investments.tsx` (keep in one file; tables share helpers + query state)

### Page-level mutations (beside `snapshotMutation`, ~180), modeled on it
- `refreshPricesMutation` → `POST /investments/stocks/refresh-prices`; onSuccess invalidate `["stock-positions"]`, `["funds-vs-stocks"]`.
- `syncYnabMutation` → `POST /accounts/ynab/sync`; onSuccess invalidate `["accounts-all"]`, `["funds-vs-stocks"]`.
- Success/error banners follow the existing `snapshotMutation` banner pattern (~226-238); show `refreshed/failed`, and `ApiError` messages for YNAB.

### Replace `PositionsCard` with three sibling Cards (rendered from `Investments`)
Reuse helpers already in the file: `num`, `fmtCAD`, `fmtNative`, `fmtPct`, `fmtSyncTime`, `cn`. Each Card returns `null` when its section is empty; if all three are empty, render the existing `EmptyPositions`.

- **`ManualFundsCard`** — columns `Position | Native balance | Market Value (CAD) | Last synced`; reuse `ManualFundRow` **unchanged** (preserve click-to-edit balance + its mutation). TOTAL row = Σ `num(f.balance_cad)`.
- **`YnabFundsCard`** — same columns/total; reuse `YnabFundRow`.
- **`StocksCard`** — the detailed table (replaces `StockRow`). Columns: `Symbol | Security | Quantity | Avg cost | Market price | Book value | Market value | All-time change ($) | All-time change (%)`.
  - Avg cost (native): `num(p.acb_total)/num(p.shares)` via `fmtNative(_, p.currency)`, guard `shares>0` else `—`.
  - Market price (native): `p.current_price` → `fmtNative` / `—`. Native cells get a small `text-muted-foreground` currency suffix (e.g. "USD"), matching `ManualFundRow`.
  - Book value / Market value (CAD): `p.acb_total_cad` / `p.current_value_cad` → `fmtCAD` / `—`.
  - Change $ (CAD): `p.unrealized_cad`; Change %: `acb_total_cad>0 ? unrealized_cad/acb_total_cad*100 : null` → `fmtPct`. Color via existing emerald/red pattern (~994-1004).
  - TOTAL row sums CAD columns only (book, market, change), skipping nulls; native columns show `—` (mixed currencies). Compute via `useMemo`.

### Action toolbar + freshness
- In `StocksCard` header (mirror the old `PositionsCard` header ~736): `"Refresh prices"` `<Button size="sm">` (disabled when pending or zero positions; label "Refreshing…") and `"Sync YNAB"` `<Button size="sm" variant="outline">`.
- Under the Stocks title: `Prices as of {fmtSyncTime(pricesAsOf)}`, where `pricesAsOf = useMemo(max of positions[].current_price_as_of)`.
- Keep "Snapshot today" — move it to the page header (top-right) so it's not bound to one table.
- Rename only the manual/YNAB header "CAD value" → **"Market Value (CAD)"** (stocks table uses "Market value").

## Shared button restyle — `apps/web/src/components/ui/button.tsx` (variant/size names unchanged)
- Base: add `active:scale-[0.98]`, widen transition to `transition-[color,background-color,box-shadow,transform] duration-150`, bump radius to `rounded-lg`.
- Variants add `shadow-sm` + hover shadow/active tints: `default` `shadow-sm hover:bg-primary/90 hover:shadow active:bg-primary/95`; `outline`/`secondary`/`destructive` get `shadow-sm` + `active:*`; `ghost` gets `active:bg-accent/80`; `link` unchanged.
- Sizes keep heights, refine radius/padding (`sm: h-9 rounded-md px-3.5`, etc.). All consumers keep working.

## Edge cases
Missing quote → native price/market value/change `—`, book value still renders; missing FX (`*_cad` null) → CAD cells `—` and excluded from totals; zero shares → guard divide-by-zero; empty sections → Card returns null; bulk refresh never blocks the page (positions read from cache) and reports partial failure via `failed`/`errors`.

## Verification
- Types/lint/tests: `pnpm --filter @helm/web typecheck`; `cd services/api && .venv/bin/python -m pytest` (add a `refresh-prices` test monkeypatching `get_quote`).
- Local dev servers (web :5173, api :8000 against the **dev** DB). Confirm `GET /investments/stocks/positions` includes `current_price_as_of`; `POST /investments/stocks/refresh-prices` returns the summary.
- UI: three separate Cards each with a TOTAL; "Market Value (CAD)" on fund tables; "Prices as of …" by the Stocks table; click Refresh prices (spinner → quotes update) and Sync YNAB (spinner → fund balances refresh); manual click-to-edit still saves; check restyled buttons in light + dark. Verify with the UX agent + Playwright per the usual workflow.

## Workflow
Branch: `feat/investing-dashboard-tables` off `dev`. Backend changes (model + endpoint) require the CDK Lambda redeploy (`pnpm exec cdk deploy helm-api-<env> -c env=<env> -c userPoolClientId=<id> --profile helm`) to reach dev/prod — push-to-main alone won't ship them.
