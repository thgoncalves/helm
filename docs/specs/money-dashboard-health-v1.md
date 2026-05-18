# Helm: Money Dashboard — Health-first redesign (V1)

## Context

The current Money Dashboard is **flow-oriented** — KPIs for this-month spend / income / net, a pacing chart, top categories, trailing-3M bars, and a bill-over-budget widget. It answers "how am I tracking against my YNAB budget this month?"

The user's mental model has shifted. After the Accounts work, every account is tagged with an orthogonal `kind` (checking / savings / investing / lending) and `owner` (personal / business). The user now wants the dashboard to answer **"how is my financial health overall?"** — a stock + ratio view, not a monthly-flow view.

Decisions locked with the user (this session):
- Delete *everything* on the current dashboard. No widget is worth preserving — start clean.
- Direction: **Health-first**, score-card style. Savings ratio, debt-to-income, liquidity (months), net-worth growth.
- Branches off `feat/accounts-management`; depends on `GET /accounts` and the cross-source taxonomy added there.
- YNAB sync stays. We still need its cached transactions to compute income / expenses; only the dashboard rendering changes.

## Recommended approach

Phased so we can ship value in stages without blocking on the trickier infra:

### Phase 1 — Health KPIs against current data

What ships:
- `/money/dashboard` is wiped to a fresh layout.
- Four KPI cards across the top — each shows current value, target line, and a small status pip (`above/at/below target`).
- Hero strip above them with **Net worth (CAD)** as the single anchor number.
- An empty-state hint where a metric can't be computed yet (e.g. "Connect YNAB for income data").

The four KPIs:

| KPI | Numerator | Denominator | Default target |
|-----|-----------|-------------|----------------|
| **Savings ratio** | (12-mo income) − (12-mo expenses), divided by 12 | 12-mo monthly income | **20%** |
| **Debt-to-income** | sum of lending-kind balances (CAD) | 12-mo annualised income | **< 30%** |
| **Liquidity (months)** | sum of checking + savings (CAD) | average monthly expenses (12-mo) | **≥ 3** |
| **Net worth** | sum of assets − sum of liabilities, CAD | n/a | tracked, no target |

Math definitions (locked):
- "Income" = sum of YNAB transactions where `amount > 0` and `transfer_account_id IS NULL`, over the trailing 365 days.
- "Expenses" = `−1 × sum(amount)` of YNAB transactions where `amount < 0` and `transfer_account_id IS NULL`, trailing 365 days.
- "Assets" = sum of (`checking + savings + investing_fund + investing_stock`) cells from the `/accounts` aggregator, CAD-converted.
- "Liabilities" = sum of (`credit_card + line_of_credit`) cells, CAD-converted, absolute value.
- All amounts shown in CAD; FX uses the existing `fx_rates` cache.

No new schema in Phase 1 — everything reads from `ynab_transactions`, `manual_accounts`, `investment_accounts`, `ynab_accounts`. New endpoint:

```
GET /money/health
{
  net_worth_cad: number,
  assets_cad: number,
  liabilities_cad: number,
  savings_ratio: { value: number|null, target: number },
  debt_to_income: { value: number|null, target: number },
  liquidity_months: { value: number|null, target: number },
  income_monthly_cad: number|null,
  expenses_monthly_cad: number|null,
  computed_at: timestamp,
  warnings: string[]   // e.g. "Brazilian FX rate is 4 days old"
}
```

Frontend wraps it in a single React Query call.

### Phase 2 — Snapshots + trend

What ships:
- New table `net_worth_snapshots` (daily granularity is overkill — weekly is fine; we'll store monthly to keep it tidy).
- A snapshot is taken after every `POST /money/ynab/refresh` and after every manual balance edit. Idempotent on `(month, day_within_month=last)` so we always have one row per month.
- New chart on the dashboard: **Net worth trend** — 12-month line chart with two series (Personal, Business) and a total annotation.
- Net-worth-growth KPI added: `(current − 90 days ago) / 90 days ago × 100`. Hidden if < 30 days of history.

Schema:
```sql
CREATE TABLE net_worth_snapshots (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_date   date NOT NULL UNIQUE,
    -- Native-currency aggregates summed by kind, CAD-converted at snapshot time.
    assets_cad      numeric(15, 2) NOT NULL,
    liabilities_cad numeric(15, 2) NOT NULL,
    -- Breakdown by Helm kind, CAD.
    checking_cad   numeric(15, 2) NOT NULL DEFAULT 0,
    savings_cad    numeric(15, 2) NOT NULL DEFAULT 0,
    investing_cad  numeric(15, 2) NOT NULL DEFAULT 0,
    lending_cad    numeric(15, 2) NOT NULL DEFAULT 0,
    -- Breakdown by owner, CAD.
    personal_cad   numeric(15, 2) NOT NULL DEFAULT 0,
    business_cad   numeric(15, 2) NOT NULL DEFAULT 0,
    created_at     timestamp with time zone NOT NULL DEFAULT now()
);
```

### Phase 3 — Editable targets + alerts

- Settings page section `health-targets`: lets user change the four default targets per their own goals.
- A small "Needs attention" panel on the dashboard, populated with whichever KPIs are below target — like a TODO list for financial health.
- (Stretch) A "stale balances" callout when any manual account's `balance_as_of > 14 days ago`.

## Visual layout (Phase 1)

```
┌──────────────────────────────────────────────────────────────────┐
│ Net worth                                              $X,XXX,XXX │
│ Personal $X,XXX,XXX · Business $XX,XXX     YNAB synced 2 min ago │
└──────────────────────────────────────────────────────────────────┘

┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Savings      │ Debt-to-     │ Liquidity    │ Net worth    │
│ ratio        │ income       │ (months)     │ trend (90d)  │
│              │              │              │              │
│ 18%      ↑   │ 35%      ↓   │ 4.2          │ +$X      ↑   │
│ Target 20%   │ Target <30%  │ Target ≥3    │              │
│ ●●●●●○       │ ●●●●○○       │ ●●●●●●       │              │
└──────────────┴──────────────┴──────────────┴──────────────┘

┌─────────── 12-month net worth trend ────────────────────────┐  (Phase 2)
│   (line chart — Personal + Business stacked)                │
└─────────────────────────────────────────────────────────────┘

┌─────────── Needs attention ─────────────────────────────────┐  (Phase 3)
│ ● Savings ratio below 20% target                            │
│ ● Itaú balance 18 days stale                                │
│ ● Personal credit card $X,XXX above last month's avg        │
└─────────────────────────────────────────────────────────────┘
```

Pip indicator uses 6 dots filled relative to target (capped at 100%). Color: emerald above-target, amber within 80–100%, red below 80%.

## Critical files

**Add**
- `services/api/app/routers/money_health.py` — `GET /money/health` aggregator.
- `services/api/app/models/money_health.py` — Pydantic shapes for the response.
- `apps/web/src/routes/MoneyDashboard.tsx` — rewritten from scratch (Phase 1).
- `apps/web/src/components/HealthKpiCard.tsx` — reusable score-card tile.
- Phase 2: `db/migrations/0015_net_worth_snapshots.sql`, `db/schema/net-worth-snapshots.ts`, snapshot capture hook in `app/ynab/sync.py` + `app/routers/accounts.py` + `app/routers/accounts_manual.py`.
- Phase 3: settings keys for the four targets; Settings page section.

**Change**
- `apps/web/src/types/api.ts` — append `MoneyHealthResponse` + supporting types. Remove `MoneyDashboardResponse` once the old endpoint is dropped.
- `services/api/app/main.py` — wire the new router; remove the existing `/money/dashboard` router include (or repurpose it).
- `services/api/app/routers/money_dashboard.py` — delete (Phase 1) or rename to `/money/spending` to keep the old views accessible (decide before merge).

**Delete**
- All KPI cards / Recharts blocks in `MoneyDashboard.tsx` — replaced wholesale.

## Open decisions to confirm before Phase 1

1. **Old YNAB-driven dashboard data**: hard delete (`money_dashboard.py` removed) or move to `/money/spending` for later? — RECOMMEND **move** so the YNAB sync's effort isn't orphaned and we can resurface flow views later without re-architecting.
2. **"Lending" definition**: does the user count mortgages here? — Defaulting to **yes** (line_of_credit kind includes mortgages per Accounts spec).
3. **Income / expense window**: trailing 365 days vs trailing 90 days? — RECOMMEND **365** for smoother ratios; user can override via Settings in Phase 3.
4. **Hide vs show metrics with insufficient data**: show "—" with explanation, or hide the card? — RECOMMEND **show with explanation** so the dashboard never appears broken.

## Verification

0. Spec + branch — this doc + `feat/money-dashboard-health` off `feat/accounts-management`. ✓
0a. UX review on the new layout before merge — UX agent against the running sandbox, same workflow as the Accounts page.
0b. Playwright: smoke test for the four KPI cards rendering with mocked /money/health response.
1. Typecheck + lint pass (3 pre-existing Settings.tsx errors continue to be the only failures).
2. Backend pytest: `GET /money/health` math — assert savings_ratio / debt_to_income / liquidity_months against seeded YNAB transactions + seeded account balances.
3. Dev deploy: `pnpm cdk deploy -c userPoolClientId=<dev id>` once Phase 1 lands.
4. End-to-end smoke in dev:
   - Sign in → /money/dashboard → all four KPI cards render.
   - Toggle a manual account balance → invalidate `["money-health"]` → KPI values shift.
   - Disconnect YNAB → income/expenses-dependent cards show the connect-YNAB empty state.

## Existing patterns to reuse

- **KPI card style**: lifted from `apps/web/src/routes/Dashboard.tsx` (Business KPI grid).
- **Aggregator endpoint pattern**: `app/routers/accounts.py::list_accounts` — single GET that reads from multiple sources, returns a flat shape.
- **CAD conversion via fx_rates**: `app/investments/fx.py::get_rate`.
- **Phase 2 snapshot hook**: piggy-back on the existing `app/ynab/sync.py::refresh` and the manual-account write paths — same idiom as how the accounts module hooks YNAB refresh today.
