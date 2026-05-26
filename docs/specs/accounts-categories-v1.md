# Accounts Categories + Manual Ordering (V1)

User-defined groupings ("Categories") for the Accounts page, with drag-to-reorder
that persists across sessions. Picks the **Atlas** concept from
[`accounts-redesign-explorations.md`](./accounts-redesign-explorations.md) —
two-pane layout with a treemap-led left rail and a roomy detail pane on the right.

User-facing name: **Categories**.
Internal code/DB name: **`buckets`** (YNAB already owns "categories" in this codebase;
keeping a different word internally prevents confusion in every join, every model, every test).

## Public-facing behavior

- New "+ New category" affordance creates a named, optionally-coloured bucket.
- Each account can be assigned to one bucket (or none → renders under
  "Uncategorized"). Drag an account across the outline to reparent.
- Accounts within a bucket order by user drag; the order persists.
- Deleting a bucket **does not** delete its accounts — they fall back to
  Uncategorized (`bucket_id` becomes NULL via `ON DELETE SET NULL`). This avoids a
  destructive surprise from a misclick.
- The current Personal/Business/Unassigned grouping is **demoted** to a per-row
  pill / filter; categories become the primary axis.
- The CAD totals strip is replaced by a treemap (rectangle area = % of net worth)
  in the left rail.

## Data model

### Migration `db/migrations/0022_account_buckets.sql`

```sql
CREATE TABLE account_buckets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  color       text,                -- palette key ("amber", "sky", ...) or hex
  sort_order  int  NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT  account_buckets_name_unique UNIQUE (name)
);

ALTER TABLE manual_accounts
  ADD COLUMN bucket_id  uuid REFERENCES account_buckets(id) ON DELETE SET NULL,
  ADD COLUMN sort_index int  NOT NULL DEFAULT 0;

ALTER TABLE ynab_accounts
  ADD COLUMN bucket_id  uuid REFERENCES account_buckets(id) ON DELETE SET NULL,
  ADD COLUMN sort_index int  NOT NULL DEFAULT 0;

CREATE INDEX ix_manual_accounts_bucket ON manual_accounts (bucket_id, sort_index);
CREATE INDEX ix_ynab_accounts_bucket   ON ynab_accounts   (bucket_id, sort_index);
```

`UNIQUE (name)` is intentional — duplicate category names would be useless in the
outline. Case-sensitive uniqueness is enough; "Daily" and "daily" can coexist
if the user insists (unlikely).

`sort_index` is per-bucket. A second account in bucket X with `sort_index=5`
sits below a first account with `sort_index=3`. Reorder = rewrite the indexes
of affected rows. We don't gap-bookend (no float ordering); a full bulk update on
drag is fine at this scale (~50 accounts max for the foreseeable future).

## Backend

### New router `services/api/app/routers/account_buckets.py`

Mounted at `/accounts/buckets`.

- `GET    /`                  → list `AccountBucketRead[]`, ordered by `sort_order`
- `POST   /`                  → create from `AccountBucketCreate {name, color?}`
- `PATCH  /{bucket_id}`       → update from `AccountBucketUpdate {name?, color?, sort_order?}`
- `DELETE /{bucket_id}`       → drop; FK `ON DELETE SET NULL` carries the cleanup

### Placement endpoint on existing `/accounts` router

- `PATCH /accounts/{source}/{account_id}/placement` →
  body `{bucket_id: uuid | null, sort_index: int}`. Validates that the source
  (`manual`|`ynab`) exists; routes the UPDATE to the right table.

### Extend the existing `/accounts` GET response

`AccountRow` gains:
```python
bucket_id: UUID | None
sort_index: int
```
and the top-level response gains a `buckets: AccountBucketRead[]` field so the
frontend can render the outline + treemap from a single query.

The list returns rows ordered by `(bucket_id IS NULL, bucket.sort_order, sort_index)`
so the natural iteration order matches what the UI renders.

### Tests `services/api/tests/test_account_buckets_router.py`

- bucket CRUD happy paths + 404s + duplicate-name 409
- DELETE bucket leaves accounts intact with `bucket_id = NULL`
- PATCH placement moves an account across buckets
- GET `/accounts` returns accounts in `(bucket sort_order, sort_index)` order

## Frontend

### New deps

```
pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

No treemap library — squarified treemap for 5-20 rectangles is ~30 LOC of plain
TS using the standard algorithm. (`d3-hierarchy` would add ~7 KB for a one-shot
visualization.)

### Types `apps/web/src/types/api.ts`

```ts
export interface AccountBucket {
  id: string;
  name: string;
  color: string | null;
  sort_order: number;
}
// AccountRow gains:
//   bucket_id: string | null;
//   sort_index: number;
// AccountListResponse gains:
//   buckets: AccountBucket[];
```

### `apps/web/src/routes/Accounts.tsx` — Atlas layout

Two-pane `grid` with `grid-template-columns: 320px 1fr`. Mobile (`<lg`) collapses
to a single column with the outline first, then the detail pane underneath.

**Left rail (320px)**

1. **Treemap** — inline SVG, ~180px tall. One `<rect>` per bucket (and one for
   Uncategorized when non-empty). Squarified layout, sized by sum of
   `balance_cad` of contained accounts. Label inside if the rect is large enough.
   Click a rect → select that bucket in the right pane.
2. **Outline** — `<ul>` of buckets, each expandable to its accounts.
   - Each bucket header: drag handle, chevron, colour ribbon, name, total CAD.
   - Each account row: drag handle, name, CAD value.
   - `dnd-kit` `DndContext` with one `SortableContext` for the bucket list and
     one per bucket for its accounts. `onDragEnd` → optimistic update + PATCH
     placement (and `/accounts/buckets/{id}` for bucket reorder).
3. **Footer** — `[+ New category]` button. Click → inline input replaces it
   briefly; Enter submits.

**Right pane (flex-1)**

Selection-driven:
- Nothing selected → "Pick an account to edit" empty state.
- Account selected → detail view: balance + 30d sparkline (from
  `stock_price_history` analogue if available, else a stub), editable fields
  (name, bank, kind, owner, category, native amount), tags, source badge,
  danger-zone delete. YNAB rows lock the editable fields and show the YNAB pill.
- Bucket selected → "category overview": rename inline, recolour, list of
  contained accounts as a mini-leaderboard, bulk "Move all to…" / "Delete
  category" actions.

State:
```ts
const [selected, setSelected] = useState<
  | { kind: "account"; rowId: string }
  | { kind: "bucket"; bucketId: string }
  | null
>(null);
```

Edit mutations reuse the existing `/accounts/manual/{id}` PATCH plus the new
placement endpoint; nothing new on the manual edit side.

## Deployment

This branch follows the spec-and-branch flow:

1. Implement on `feat/accounts-categories-redesign` (already checked out).
2. Apply 0022 migration to dev DB (RDS Data API one-off).
3. Local smoke against the dev DB.
4. Push branch → Amplify sandbox build for visual review.
5. Merge to `dev` → push → `cdk deploy helm-api-dev -c userPoolClientId=4ruesl329oslgarccfh2qa6k6o`.
6. Apply 0022 to prod DB.
7. Merge to `main` → push → `cdk deploy helm-api-main -c env=main -c userPoolClientId=4srae6rkc0o1paikd3e2117oq5`.

## Risks

- **Drag-and-drop on touch** — `@dnd-kit` supports touch sensors out of the box,
  but the outline rail is narrow; on iPad portrait the rail collapses to a
  bottom sheet and drag gets awkward. Acceptable for V1; revisit if you actually
  use the page on mobile.
- **Squarified treemap implementation** — small algorithm but easy to get wrong
  when one rect dominates (Emergency fund 48% in the mockup data). Snapshot
  tests on the layout function catch the worst regressions.
- **YNAB-account placement** — YNAB rows currently get their `helm_kind` tagged
  on the same row; we're now letting users also set `bucket_id` on them. Sync
  must preserve `bucket_id` and `sort_index` across syncs (UPSERT must not
  overwrite them).

## Out of scope

- Per-category goals / budgets (a different feature; would belong to Money
  Health).
- Drag-to-recolor via the treemap (whimsical idea, defer).
- Multi-select drag (defer; single-account drag is the V1 contract).
- Account history sparkline persistence (if we don't have balance history per
  account, render a stub or hide the sparkline).
