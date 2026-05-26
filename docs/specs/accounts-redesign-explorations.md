# Accounts page — redesign explorations

Status: design exploration / not a commitment
Owner: th.goncalves@gmail.com
Reference screenshot: `/tmp/accounts-current.png`
Current implementation: `apps/web/src/routes/Accounts.tsx` (733 lines)

## 1. What the current page does today

The page shows a sticky top bar (`Sync YNAB`, `Add brokerage`, `Add cash account`), a 3-card CAD totals strip grouped by `owner` (Personal / Business / Unassigned), and then one `<Card>` per owner containing a vertical list of rows. Each row is identity-on-the-left, balance-on-the-right, with two inline `<select>` dropdowns for `kind` and `owner` and an "Edit" toggle that expands a 6-field grid form below the row. YNAB-sourced rows are read-only except for the two tag dropdowns; manual rows get Edit + Delete.

The result is dense but flat: every account is one of N rows in one of three buckets, the dropdowns make the row visually busy, and there is no notion of personally meaningful grouping ("emergency fund", "Brazil savings", "kids") or persistent ordering — the user cannot put their daily-spending checking at the top.

## 2. New constraints driving the redesign

- **Categories** — user-defined groups (CRUD). Internally called `account_buckets` so they don't collide with YNAB's budget "categories".
- **Manual ordering** — drag-to-reorder within and across categories, persisted to the backend as `(bucket_id, sort_index)` on each account.
- **Preserve**: `name`, `bank`, `balance` (native), `balance_cad`, `kind`, `owner`, `source`, `last_synced_at`; manual = editable, YNAB = read-only; "Sync YNAB" stays prominent; "Add cash" + "Add brokerage" remain reachable.
- **Free to drop or demote**: the CAD totals strip, owner-as-primary-grouping, the expand-in-place editor.

---

## Concept A — The Ledger (dense, spreadsheet-style, power-user)

A single full-width table where the leftmost column is a category band and every account is one row. The user lives in keyboard-first land: arrow keys move the selection, `Enter` opens a slide-in drawer to edit, `Cmd+drag` on the row handle reorders. Columns are sortable but the user's manual order always wins until they click a column header (after which a "Manual order" pill lets them snap back).

```
+--------------------------------------------------------------------------------------------+
| Accounts            search: [_____]   sort: Manual ▾    [Sync YNAB •2m] [+Cash] [+Brokerage] |
+--------------------------------------------------------------------------------------------+
| ⠿  CATEGORY                NAME              BANK       KIND      OWNER   BAL (native)  CAD |
| ▼  Daily spending          ----------------------------------------------------------------|
| ⠿     RBC Chequing         RBC        chk      personal  C$ 2,184.10   C$2,184 |
| ⠿     Wealthsimple Cash    WS         chk      personal  C$    932.55  C$  932 |
| ⠿     Itaú Conta Corrente  Itaú       chk      personal  R$  4,210.00  C$1,051 |
| ▼  Emergency fund          --------------------------------------- (drag rows here) -------|
| ⠿     EQ Bank HISA         EQ         sav      personal  C$24,000.00   C$24,000 |
| ▼  Brazil savings          ----------------------------------------------------------------|
| ⠿     Nubank Caixinha      Nubank     sav      personal  R$ 12,400.00  C$3,096 |
| ▶  Business (3) ………………………………………………………………………………………………………… C$ 18,402 ▾                       |
| ▶  Uncategorized (2) ……………………………………………………………………………………… C$    430 ▾                       |
+--------------------------------------------------------------------------------------------+
| 12 accounts • Personal C$31,295 • Business C$18,402 • Unassigned C$430 • Net C$50,127  ▾    |
+--------------------------------------------------------------------------------------------+
```

- **Categories** — managed inline. The category band header is `[⠿] [▼] Name (n) [+ add account] [⋯]`. The `⋯` menu has Rename / Delete / Change colour. A `+ New category` chip lives at the bottom of the list. Inline rename = double-click the header.
- **Drag-to-reorder** — `dnd-kit` with one `SortableContext` per category list plus a top-level `SortableContext` of category headers. Dragging a row onto a different category header reparents it (snapshot of new `bucket_id` + `sort_index` PATCHed on drop).
- **Disappears / moves** — the big KPI strip collapses into a single sticky footer bar (still always visible). Owner becomes a column (filterable header), not the primary grouping. The expand-to-edit pattern is replaced by a right-hand `<Sheet>` drawer for editing, which keeps the table layout intact.
- **Trade-offs** — fastest for a user with many accounts who knows what they want; lets you eyeball the whole portfolio in one screen. Pays for that with visual density (every row has 7+ data points), and is the least friendly on mobile — the table needs horizontal scroll under ~900px.

---

## Concept B — The Pinboard (card-based, visual, drag-heavy)

A two-dimensional board: categories are vertical stacks ("columns lite") and each account is a thick rounded card you can grab. Colours come from the category, not the kind, so the board reads at a glance: green stripe = Emergency fund, blue stripe = Brazil savings. Balance is the loud thing on the card; metadata fades back. Owner is shown as a small pill, not a grouping axis.

```
+----------------------------------------------------------------------------------+
| Accounts                                       [Sync YNAB •2m]  [+Cash] [+Brkrg]|
| Net worth   C$ 50,127  ▲ +1.2% / 30d                                             |
+----------------------------------------------------------------------------------+
|                                                                                  |
|  ┃ Daily spending       ⋯ |  ┃ Emergency fund  ⋯ |  ┃ Brazil savings    ⋯       |
|  ┃ C$ 4,167               |  ┃ C$ 24,000          |  ┃ C$ 3,096                   |
|  ┌────────────────────┐  |  ┌────────────────────┐ |  ┌────────────────────┐     |
|  │ RBC Chequing       │  |  │ EQ Bank HISA       │ |  │ Nubank Caixinha    │     |
|  │ C$ 2,184.10        │  |  │ C$ 24,000.00       │ |  │ R$ 12,400          │     |
|  │ chk · personal·YNAB│  |  │ sav · personal·YNAB│ |  │ ≈ C$ 3,096 · sav   │     |
|  └────────────────────┘  |  └────────────────────┘ |  └────────────────────┘     |
|  ┌────────────────────┐  |                          |  + add account             |
|  │ Wealthsimple Cash  │  |  + add account            |                            |
|  │ C$    932.55       │  |                          |                            |
|  └────────────────────┘  |  ┃ Business ops  ⋯       |  ┃ + New category          |
|  ┌────────────────────┐  |  ┃ C$ 18,402             |                            |
|  │ Itaú Corrente      │  |  ┌────────────────────┐ |                            |
|  │ R$ 4,210 · ≈C$1,051│  |  │ RBC Business chk   │ |                            |
|  └────────────────────┘  |  │ C$ 12,400          │ |                            |
|  + add account            |  └────────────────────┘ |                            |
+----------------------------------------------------------------------------------+
```

- **Categories** — each is a column. Header = `[colour] Name  [total]  [⋯]`. The `⋯` menu has Rename / Recolour / Delete (delete prompts: "Move accounts to…"). A persistent `[+ New category]` placeholder column at the right end. Reorder columns by dragging their header.
- **Drag-to-reorder** — natural kanban semantics: drag a card up/down inside its column or across to another column. `dnd-kit` `SortableContext` per column, plus column-level reorder. Drop fires `PATCH /accounts/{id}/placement {bucket_id, sort_index}`.
- **Disappears / moves** — owner grouping is gone; owner becomes a tiny pill on the card (and a filter chip in the header). The 3-card CAD totals strip collapses into a one-line net-worth ribbon at the top. Click a card → side `<Sheet>` for full edit; no inline expansion.
- **Trade-offs** — beautiful, immediately legible, and the drag interaction is obvious. But it scales poorly past ~6 categories (horizontal scroll on desktop), it shows fewer columns of metadata than the ledger, and on mobile each "column" becomes a stacked accordion which feels like a regression to today's layout.

---

## Concept C — The Atlas (master-detail with a portfolio map)

A two-pane layout. The left pane is a thin, scannable navigator: a treemap visualization at the top (each rectangle = a category, sized by CAD balance, fill by colour) plus a flat outline of categories with accounts nested under each. The right pane is the detail surface — when you click an account, the whole right pane becomes a rich edit/detail view (balance history sparkline, all editable fields, last sync, danger zone). When you click a category, the right pane becomes a category overview (totals, mini-leaderboard of accounts by size, bulk actions).

```
+----------------------------------------------------------------------------------+
| Accounts                       [Sync YNAB •2m]   [+Cash] [+Brokerage]            |
+------------------+---------------------------------------------------------------+
|  PORTFOLIO MAP   |  Detail · RBC Chequing                                        |
|  +-----+--+---+  |  ─────────────────────────────────────────────────────────── |
|  | EMG |DA|BR|  |  Bank   RBC Royal Bank                                         |
|  |     |IL|SV|  |  Kind   [Checking ▾]      Owner [Personal ▾]                  |
|  |     |Y |  |  |  Category [Daily spending ▾]   Source  YNAB (read-only)        |
|  +-----+--+---+  |                                                               |
|  | BIZ | UNC  |  |  Balance (CAD)     C$ 2,184.10                                |
|  +-----+------+  |  Last synced       2 minutes ago                              |
|                  |                                                               |
|  CATEGORIES ⠿+   |   ▁▂▃▅▆▇▇▆▅▆▇ 30-day balance ──────────────                   |
|  ▼ Daily         |                                                               |
|     ⠿ RBC Chk ●  |  Notes  (manual rows only — disabled)                         |
|     ⠿ WS Cash    |                                                               |
|     ⠿ Itaú       |  Tags   #liquid  #joint  [+]                                  |
|  ▼ Emergency     |                                                               |
|     ⠿ EQ HISA    |  ────────────────────────────────────────────────────────     |
|  ▼ Brazil sv     |  YNAB rows are read-only · last refresh 2 min ago             |
|     ⠿ Nubank     |                                                               |
|  ▼ Business      |                                                               |
|     ⠿ RBC Biz    |                                                               |
|     ⠿ Stripe     |                                                               |
|  ▶ Uncategorized |                                                               |
|  + new category  |                                                               |
+------------------+---------------------------------------------------------------+
```

- **Categories** — managed in the left rail. Hover a category to reveal its `⋯`. Drag the treemap rectangle to recolour by swapping with another (whimsical, optional). `+ new category` is a button at the bottom of the rail; rename via inline edit on click.
- **Drag-to-reorder** — works in the outline rail (the right pane never moves). One `dnd-kit` tree with collapsible categories; drop an account into another category to reparent. The treemap is read-only (visualization, not interaction), updated reactively.
- **Disappears / moves** — owner is fully demoted to a `<select>` in the detail pane; it stops being a grouping axis. CAD totals strip is replaced by the treemap, which is a far better answer to "where is my money concentrated?". The expand-to-edit row pattern is gone — editing always happens in the right pane.
- **Trade-offs** — by far the best for *understanding* a portfolio (the treemap is the page's killer feature) and editing is calm and roomy. The cost: it's a two-pane layout, so on mobile/narrow it collapses to "list → drill into detail", which loses the treemap above the fold. Also: implementing a reasonable treemap is a half-day on its own (`d3-hierarchy` + SVG), where A and B reuse pure CSS/flex.

---

## 3. Recommendation — **Concept C, The Atlas**

I'd build Concept C. Reasoning, with the trade-offs out in the open:

- **The page's job is decision-making, not data entry.** This user already has tagged-and-synced accounts; what they actually do here weekly is glance at the shape of their money (where's the cash sitting?) and occasionally edit one row. The Atlas optimizes for both: the treemap answers the glance question in 0.5 seconds, and the right pane gives edits the room they deserve.
- **Categories become spatially meaningful.** In A and B, a category is a header or a column tint — it's a label. In C, a category is a rectangle whose size *is* its weight in your net worth. That changes the kind of conversation the page can have with you ("emergency fund is shrinking relative to checking" is visible without thinking).
- **Drag-to-reorder is calmer here.** A tree-style outline with a left-rail dnd handle is a well-understood pattern (Notion, Linear); ledger row drag is fiddly with selects, and kanban drag across many columns gets thrashy.
- **It scales with categories.** B starts breaking at 6+ columns. C is fine at 20 categories because the rail just scrolls and the treemap stays meaningful.
- **The honest cost:** treemap implementation effort (~half a day) and a slightly more involved mobile layout. Both are acceptable given this is a power-user page on a desktop-first product, and the treemap can ship in v2 if we want to bias the first cut toward the rail + detail pane only.

If we wanted a safer fallback, Concept A is the right pick — it's the smallest leap from today and the highest information density per pixel. Concept B is the prettiest but the hardest to grow into.
