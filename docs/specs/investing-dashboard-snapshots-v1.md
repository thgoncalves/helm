# Investing Dashboard — Position Snapshots v1

## Why

Today the Investing area has live position views (Stocks, Research) but
no concept of **time**. The user can see what they hold right now, but
not how the total has changed over weeks/months. Stock holdings can be
re-derived from transactions × historical prices, but **manual funds**
(XP, Santander) only carry a single live balance — the moment it's
edited, the prior value is lost.

This spec adds a "snapshot" primitive: a frozen per-source position
captured on a specific date, stored as time-series, and surfaced as a
chart on the Investing **Dashboard** (formerly Overview).

## Out of scope

- Per-ticker time-series (already reconstructible from transactions +
  historical Twelve Data prices — separate feature).
- Auto/daily snapshots — manual-trigger only for v1. Adding cron later
  is straightforward.
- Editing past snapshots — v1 lets you re-snapshot today (UPSERT) but
  not back-date or amend historical rows.

## Schema

```sql
-- db/migrations/0021_investing_snapshots.sql
CREATE TABLE IF NOT EXISTS investing_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  snapshot_date   DATE NOT NULL,
  source_kind     TEXT NOT NULL,           -- 'manual_fund' | 'ynab_fund' | 'stocks'
  source_id       TEXT,                    -- manual_accounts.id (uuid) or ynab_accounts.id (string); NULL for stocks
  label           TEXT NOT NULL,           -- denormalized for display
  native_currency TEXT NOT NULL,
  native_amount   NUMERIC(18,2) NOT NULL,
  cad_amount      NUMERIC(18,2) NOT NULL,
  fx_rate         NUMERIC(18,8) NOT NULL,  -- native→CAD on snapshot date
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Three partial unique indexes — one per source_kind. Cleaner than
-- COALESCE(...) when source_id is text/null, and lets ON CONFLICT
-- name the matching predicate explicitly.
CREATE UNIQUE INDEX uniq_investing_snapshot_manual
  ON investing_snapshots (snapshot_date, source_id) WHERE source_kind = 'manual_fund';
CREATE UNIQUE INDEX uniq_investing_snapshot_ynab
  ON investing_snapshots (snapshot_date, source_id) WHERE source_kind = 'ynab_fund';
CREATE UNIQUE INDEX uniq_investing_snapshot_stocks
  ON investing_snapshots (snapshot_date)            WHERE source_kind = 'stocks';

CREATE INDEX ix_investing_snapshot_date
  ON investing_snapshots (snapshot_date DESC);
```

## Snapshot composition

Three sources, each pulling balance from where it lives — that's the
"works automatically where it can, manual where it has to" contract
the user asked for.

When `POST /investments/snapshots` is called:

1. **Manual funds** (`source_kind='manual_fund'`) — every active row in
   `manual_accounts` where `kind = 'investing_fund'`. Balance is whatever
   the user typed via the Dashboard's inline edit (PATCH
   `/accounts/manual/{id}`). Native currency stays native; FX-converted
   to CAD via the BoC cache (`app.investments.fx.get_rate`).

2. **YNAB-linked funds** (`source_kind='ynab_fund'`) — every row in
   `ynab_accounts` tagged `helm_kind = 'investing_fund'`, excluding
   closed/deleted accounts. Balance comes from YNAB's last-synced
   `balance` (milliunits → decimal). Assumed CAD-denominated per the
   `/accounts` router's convention; if a non-CAD YNAB budget appears,
   `_convert` will route it through the FX cache.

3. **Stocks aggregate** (`source_kind='stocks'`) — sum across all
   `stock_transactions`:
   - Per-ticker shares: `SUM(quantity)` grouped by ticker.
   - Per-ticker last price: latest row in `stock_quotes`, falling back
     to nothing (skip ticker silently — no live quote = excluded).
   - Per-ticker value: shares × price, converted from quote currency
     to CAD using the same FX table.
   - One snapshot row: `source_kind='stocks'`, `source_id=NULL`,
     label='Stocks', native_currency='CAD', native_amount=cad_amount,
     fx_rate=1.0, cad_amount = sum of per-ticker CAD values.

UPSERT semantics: same-day re-snapshot replaces all rows for that
date. Wraps in a transaction so partial failure leaves no torn state.

## Backend — `app/routers/investments_snapshots.py`

```
POST   /investments/snapshots
       → 200 { snapshot_date, rows: [{label, source_kind, source_id,
                                       native_currency, native_amount,
                                       cad_amount, fx_rate}], total_cad }

GET    /investments/snapshots/history
       → 200 { items: [{snapshot_date, total_cad,
                        by_source: [{label, cad_amount}]}] }
       Ordered by snapshot_date ASC, suitable for direct chart feed.

GET    /investments/snapshots/{snapshot_date}
       → 200 same shape as POST; 404 if no snapshot for that date.
```

Auth: same JWT requirement as the rest of `/investments/*`.

FX: reuses the existing `app.investments.fx.to_cad(amount, currency)`
helper (already used by Stocks landing for "Show CAD equivalents").

## Frontend — `apps/web/src/routes/Investments.tsx`

Replaces the current page. Sections top to bottom:

1. **Page header**
   - "Investing Dashboard" + last-snapshot indicator
     ("Last snapshot: May 22, 2026" or "No snapshots yet").
   - Primary button "Snapshot today" (right-aligned). Disabled if
     `manualFunds.length === 0 && stocksAggregate.cad_amount === 0`.

2. **Positions card**
   - Table with two regions:
     - "Funds" — one row per manual investing fund.
       Columns: name | native balance (editable inline) | CAD value.
       Edit submits `PATCH /accounts/{id}` and invalidates the query.
     - "Stocks" — single read-only row, CAD value only, with a tooltip
       showing per-ticker breakdown.
   - Footer row: "Total" in CAD.

3. **History chart**
   - Recharts line chart of total CAD over time.
   - Toggle: line (total only) vs. stacked area (by source).
   - X axis: snapshot_date. Y axis: CAD with k/M suffix.
   - Empty state: muted "Take your first snapshot to start tracking."

## Tests

Backend (`services/api/tests/test_investments_snapshots.py`):
- POST creates rows for every fund + stocks aggregate.
- POST twice same day UPSERTs (count stable, values updated).
- POST with no funds + no quotes returns empty rows but still 200.
- GET /history returns ASC-sorted items with per-source breakdown.
- FX conversion math: BRL fund @ rate → CAD matches.
- Stocks aggregate excludes tickers with no cached quote.

Frontend (manual + Playwright):
- Snapshot button reflects today's date after click.
- Edit fund balance → CAD column updates → snapshot picks up new value.
- Chart renders 2+ snapshot points.

## Migration / rollout

1. Apply `0021_investing_snapshots.sql` to dev DB (empty table — safe).
2. Deploy backend (CDK).
3. Push frontend to dev (Amplify auto-rebuild).
4. Smoke test on dev.
5. Apply migration to prod DB.
6. Deploy backend to prod.
7. Push frontend to main.

Production data risk: zero. New table, no schema changes to existing
tables, no data backfill required. First snapshot the user takes
captures the current state.
