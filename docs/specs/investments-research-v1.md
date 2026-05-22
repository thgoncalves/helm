# Investments — Research V1

Status: **approved**, in-progress on `feat/stocks-research`.

A new "Research" tab inside the Investments module that surfaces a curated
shortlist of stocks (US + TSX) with current price, day change, and the
user's position when held. Designed as a *what should I buy next?*
browsing surface that links into the existing `/investments/stocks/:ticker`
detail page for charting + buying.

## Decisions locked

| Question | Answer |
| --- | --- |
| Universe | Curated shortlist (~55 tickers across sectors) — expandable later |
| Fundamentals (P/E, market cap, yield) | Defer to V2 |
| Position column | Shares + CAD-converted value |
| Refresh strategy | On-demand + 24h cache; per-row refresh button |

## Out of scope (V1)

- Fundamentals: P/E, market cap, dividend yield, 52-week hi/lo
- User-editable watchlist (adding/removing tickers from the page)
- Inline price charts (the existing detail page already has them)
- "Refresh all" bulk action — defer; current per-row pattern is enough
- Alerts / price targets

## Universe — starter list (~55)

Seeded once via migration. Edits are SQL-only until V2.

**US (~42):**
- Tech: AAPL, MSFT, GOOGL, NVDA, META, AMZN, AVGO, ORCL, CRM, ADBE
- Financials: JPM, BAC, V, MA, GS, BRK.B
- Healthcare: UNH, LLY, JNJ, PFE, ABBV, TMO
- Consumer Staples: WMT, PG, KO, PEP, COST
- Consumer Discretionary: HD, MCD, NKE, SBUX, DIS
- Energy: XOM, CVX
- Industrial: CAT, BA, HON, RTX
- Communications: NFLX, T, VZ
- Utilities: NEE
- ETFs: SPY, VOO, QQQ, VTI

**TSX (~13):**
- Banks: RY.TO, TD.TO, BNS.TO, BMO.TO, CM.TO
- Energy: ENB.TO, CNQ.TO, SU.TO
- Telecom: BCE.TO, T.TO
- Industrial: CNR.TO, CP.TO
- Tech: SHOP.TO

## Data model

```sql
CREATE TABLE research_tickers (
  ticker      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sector      TEXT NOT NULL,         -- "Technology", "Financials", etc.
  industry    TEXT,                  -- optional finer cut
  country     CHAR(2) NOT NULL,      -- "US" | "CA"
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX research_tickers_sector_idx ON research_tickers(sector);
```

Prices reuse the existing `stock_quotes` cache. Stale threshold for the
research view = 24h (the cache itself is 15-min, but research tolerates
older data without re-fetching).

## API

`GET /investments/research`

Returns one row per ticker, ordered by `sort_order, ticker`.

```ts
interface ResearchRow {
  ticker: string;
  name: string;
  sector: string;
  industry: string | null;
  country: "US" | "CA";

  // From stock_quotes (LEFT JOIN). null when no quote has ever been
  // fetched for this ticker.
  last_price: string | null;
  currency: string | null;          // quote currency, "USD" / "CAD" / etc.
  previous_close: string | null;
  fetched_at: string | null;        // ISO timestamp; lets the UI render age
  day_change_pct: string | null;    // computed (last - prev) / prev * 100

  // Aggregated from stock_transactions across all sources for this ticker.
  // 0 / null when the user holds no position.
  position_shares: string;          // "0" when none
  position_currency: string | null; // trade currency of the position
  position_value_native: string | null;  // shares * last_price in trade ccy
  position_value_cad: string | null;     // FX-converted, null on FX miss
}
```

`POST /investments/research/refresh/{ticker}` → 200 with the refreshed
`ResearchRow`. Forces a Twelve Data quote refresh for one ticker (uses 1
of the 800/day budget).

`day_change_pct` formula: `(last_price - previous_close) / previous_close
* 100`, computed server-side so the UI never has to deal with the math.
`null` whenever either input is null.

## UI — `/investments/research`

New tab in `INVESTMENTS_NAV` between Overview and Stocks.

**Header row**: title + sector filter dropdown + sort dropdown
(default: by ticker). Eventually a search input.

**Table columns:**

| Col | Source |
| --- | --- |
| Ticker | `ticker` (monospace, click → `/investments/stocks/:ticker`) |
| Name | `name` |
| Sector | `sector` (small chip / muted) |
| Country | `country` flag (US 🇺🇸 / CA 🇨🇦) — optional, can be inline w/ ticker |
| Price | `last_price + currency`, with `≈ $X CAD` underneath when ≠ CAD |
| Day Δ | `day_change_pct` with `▲ +1.2%` / `▼ -0.4%` color + glyph; `—` when null |
| Position | `10 sh · $2,150 CAD` when held; `—` when not |
| ↻ | refresh button, calls POST /refresh/{ticker} |

Price age annotation: when `fetched_at` is null, show "Click ↻". When >
24h old, show "Stale — Xd". When ≤ 24h, show no annotation (the price is
trustworthy enough).

Empty state: never — universe is always populated. If a row has no
position and no quote, it still renders as a "click ↻ to load" cell.

## Implementation notes

- `_to_cad_strict` helper from `investments_stocks.py` is the same FX
  shape we want for `position_value_cad` — extract to a shared module
  (`app/investments/fx.py` already lives there; the strict variant can
  go in `app/investments/stocks_quotes.py`'s caller scope or a small new
  `app/investments/cad.py`). Decision deferred to implementation; keep
  it inline initially if it stays small.
- Position aggregation reuses the same query shape as the Stocks
  landing's `list_positions` — filter by ticker, sum across sources.
- The router mounts at `/investments/research` (not under `/stocks` —
  it's its own concern and shouldn't grow under the stocks namespace).

## Future / V2 candidates

- Fundamentals strip in each row (P/E, market cap, yield) — needs a
  paid Twelve Data tier or a free-tier yfinance Lambda. Reassess after
  using V1 for a few weeks.
- User-managed watchlist (add/remove from the page).
- Search by company name across the universe.
- Sector-rollup view: "What's your exposure?" — compare to your
  holdings.
- Compare-mode: select 2-4 rows → side-by-side stat strip.
- Alerts: "tell me when AAPL crosses $X".
