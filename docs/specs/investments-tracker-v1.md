# Investments — V1 portfolio tracker

## Context

The Investments module currently ships as a placeholder. This phase makes it a real read-only tracker: enter holdings by hand across four account types, see allocation and drift versus targets, with Brazilian holdings auto-converted to CAD via Bank of Canada daily rates.

Out of scope for V1 (deliberately):

- CSV imports from Scotia iTrade (deferred; manual entry first to validate the data model)
- LLM-assisted research panel (Claude API integration — separate follow-on phase)
- Lot-by-lot cost basis (positions-only by user's request)
- Day-trading affordances; the philosophy is 6+ month retention, so no "candidate sells" prompts

Decisions locked with the user:

- **Granularity**: one row per `(account, ticker)`. No purchase lots.
- **Account types supported**: Scotia iTrade (CAD, taxable), RRSP, TFSA, Brazilian (BRL), Business corp (CAD). Five total.
- **FX**: Bank of Canada daily rates (free, no API key). Helm fetches on demand and caches in Postgres.
- **Target allocation**: by **asset class**, not by ticker.
- **Single-user**: no `user_id` columns.

## Data model

Five new Drizzle tables under `db/schema/`:

### `investment_accounts`
- `id` UUID PK
- `name` text (e.g. "iTrade Personal", "RRSP — Questrade")
- `kind` varchar(20): `"itrade" | "rrsp" | "tfsa" | "brazil" | "corp"`
- `currency` varchar(3) (default CAD; BRL for Brazilian)
- `owner_label` text nullable (e.g. "Joint with spouse" — informational only)
- `contribution_limit` numeric(15,2) nullable — TFSA/RRSP only
- `notes` text
- `is_active` bool default true
- timestamps

### `investment_holdings`
- `id` UUID PK
- `account_id` UUID FK → `investment_accounts.id`
- `ticker` text (e.g. "VEQT.TO", "AAPL", "PETR4")
- `asset_class` varchar(30): see enum below
- `shares` numeric(20, 8) — high precision for fractional shares
- `avg_cost` numeric(15, 4) — per-share, in account currency
- `current_price` numeric(15, 4) — per-share, in account currency, manually updated
- `currency` varchar(3) — inherited from account at creation but stored for clarity
- `as_of` date — when `current_price` was last set
- `notes` text
- timestamps
- Unique `(account_id, ticker)` so accidental duplicates fail loudly

### `target_allocations`
- `asset_class` PK varchar(30) — same enum as above
- `target_pct` numeric(5, 2) — must sum to 100 across all rows (enforced at API layer)
- `updated_at` timestamptz

### `fx_rates`
- `(from_currency, to_currency, rate_date)` composite PK
- `rate` numeric(15, 8) — units of `to_currency` per 1 unit of `from_currency`
- `source` text (always `"BoC"` in V1)
- `fetched_at` timestamptz

### Asset class enum (Pydantic + frontend constant)
```
equity_ca, equity_us, equity_international,
bonds, cash, alternative, real_estate, crypto, other
```

## FX integration

- Bank of Canada Valet API: `https://www.bankofcanada.ca/valet/observations/FX{from}{to}/json?recent=1`
- Single function `app.investments.fx.get_rate(from_ccy, to_ccy, on=date) -> Decimal`:
  1. Check `fx_rates` table for the requested date.
  2. If missing, fetch latest from BoC (recent=1), upsert.
  3. If BoC fetch fails (rate-limit, network), fall back to the most recent cached rate within 7 days. Raise if nothing available.
- BoC has no API key, no rate limit worth tuning for; the cache is just to keep dashboard loads fast.
- For V1 only `BRL → CAD` is fetched. Wire is general so we can add USD later if Scotia accounts ever hold non-CAD positions.

## API endpoints

All under `/investments/*` prefix (router already declared as a 501 stub — replace).

- `GET    /investments/accounts`                — list (filter by `?active=true`)
- `POST   /investments/accounts`                — create
- `PATCH  /investments/accounts/{id}`           — update (incl. archive)
- `DELETE /investments/accounts/{id}`           — hard delete if no holdings
- `GET    /investments/holdings`                — list (filter by `?account_id=`)
- `POST   /investments/holdings`                — create
- `PATCH  /investments/holdings/{id}`           — update (typically `current_price` + `as_of`)
- `DELETE /investments/holdings/{id}`
- `GET    /investments/targets`                 — list current targets
- `PUT    /investments/targets`                 — replace entire set (atomic; sum must equal 100)
- `GET    /investments/portfolio`               — single-shot dashboard payload (see below)
- `POST   /investments/fx/refresh`              — manual refresh of BRL→CAD; returns the new rate

### `GET /investments/portfolio` response shape

```json
{
  "as_of": "2026-05-18",
  "currency": "CAD",
  "totals": {
    "market_value": "250000.00",
    "cost_basis":   "210000.00",
    "unrealized":   "40000.00",
    "unrealized_pct": "19.05"
  },
  "by_account_kind": [
    { "kind": "itrade",  "market_value": "...", "share_pct": "..." },
    { "kind": "rrsp",    "market_value": "...", "share_pct": "..." },
    { "kind": "tfsa",    "market_value": "...", "share_pct": "..." },
    { "kind": "brazil",  "market_value": "...", "share_pct": "..." },
    { "kind": "corp",    "market_value": "...", "share_pct": "..." }
  ],
  "allocation": [
    {
      "asset_class": "equity_us",
      "market_value": "...",
      "actual_pct":  "42.10",
      "target_pct":  "40.00",
      "drift_pct":   "2.10"
    }
  ],
  "holdings": [
    {
      "id": "...",
      "account_id": "...",
      "account_name": "iTrade Personal",
      "account_kind": "itrade",
      "ticker": "VEQT.TO",
      "asset_class": "equity_international",
      "shares": "100.00000000",
      "avg_cost": "30.50",
      "current_price": "33.20",
      "currency": "CAD",
      "market_value_native": "3320.00",
      "market_value_cad":    "3320.00",
      "unrealized": "270.00",
      "unrealized_pct": "8.85",
      "as_of": "2026-05-17"
    }
  ],
  "fx_rates_used": { "BRL_CAD": { "rate": "0.27", "rate_date": "2026-05-17" } }
}
```

Backend does FX conversion at the holding level; frontend never reconverts.

## Frontend

Replace the `InvestmentsHome` placeholder; add new routes:

- `/investments`                  — Portfolio overview (KPIs + allocation table + by-kind donut/bar + holdings table)
- `/investments/accounts`         — Account list with add/edit modal
- `/investments/holdings/new`     — Add holding form
- `/investments/holdings/:id`     — Edit holding (mostly used to update `current_price` + `as_of`)
- `/investments/targets`          — Set target allocation (form: 9 rows for the asset classes, must sum to 100)

`INVESTMENTS_NAV` in `AppHeader.tsx` grows from one item to four:
`Overview · Accounts · Holdings · Targets`.

Reuse:
- `Dashboard.tsx`-style KPI grid + Recharts for visuals
- The Settings sidebar+scroll-spy pattern for Targets (one section per asset class? probably not — single table)
- The `apiFetch` + `useQuery` pattern from existing routes
- The `formatCAD` helper from `lib/invoice`

## Critical files

**Add (frontend)**
- `apps/web/src/routes/Investments.tsx`           — Overview (replaces InvestmentsHome)
- `apps/web/src/routes/InvestmentAccounts.tsx`
- `apps/web/src/routes/HoldingForm.tsx`           — both new + edit
- `apps/web/src/routes/InvestmentTargets.tsx`

**Add (backend)**
- `services/api/app/routers/investments_accounts.py`
- `services/api/app/routers/investments_holdings.py`
- `services/api/app/routers/investments_portfolio.py`
- `services/api/app/routers/investments_targets.py`
- `services/api/app/models/investments.py`
- `services/api/app/investments/__init__.py`
- `services/api/app/investments/fx.py`               — BoC client + cache helpers
- `services/api/app/investments/portfolio.py`        — rollup + drift math

**Add (DB)**
- `db/schema/investments.ts`
- `db/migrations/0010_investments_tracker.sql`
- `db/migrations/meta/0010_snapshot.json` (regen + journal append)

**Change**
- `apps/web/src/App.tsx`             — new routes
- `apps/web/src/components/AppHeader.tsx` — expand `INVESTMENTS_NAV`
- `apps/web/src/routes/InvestmentsHome.tsx` — delete (replaced by Investments.tsx)
- `services/api/app/main.py`         — replace stub `investments` router with 4 prefixed routers
- `services/api/app/routers/investments.py` — delete (replaced)
- `apps/web/src/types/api.ts`        — add Investment* + Portfolio* types

## Verification

1. **Backend**: `uv run pytest -q` plus new tests for FX upsert path + portfolio math (FX conversion + drift calc + drift signed correctly when actual < target).
2. **Migration**: apply via the same `apply_migration_*.py` pattern; verify 5 tables exist.
3. **Sandbox smokes**:
   - Add an account in each kind (itrade / rrsp / tfsa / brazil / corp).
   - Add holdings; one BRL holding in the Brazilian account; verify portfolio endpoint reflects CAD conversion.
   - Set targets summing to 100; tweak one to 110 and verify the API rejects.
   - `/investments` page renders KPIs + drift table.
4. **Playwright**: extend `e2e/public.spec.ts` to confirm `/investments/accounts`, `/investments/targets` route guards still redirect to SignIn unauthenticated.
5. **UX/UI review**: run the same review agent against the new pages once they render.

## Open follow-ons (after V1 ships)

- Scotia iTrade CSV import (so the user stops typing positions by hand).
- LLM research panel (Claude API + web fetch; targeted at a watchlist column).
- Lot-by-lot cost basis (capital-gains math).
- Crypto pricing (CoinGecko free tier?) once BRL FX has shaken out.
- Yahoo Finance / Polygon price polling so `current_price` isn't manual.
