"""FastAPI router for the ``/business/time-entries`` endpoints.

The Timesheets page issues two kinds of requests:

* ``GET  /business/time-entries?client_id=X&start=Y&end=Z`` — fetch the
  entries for a given client across an inclusive date range. Used to hydrate
  the calendar grid for a month view.
* ``PUT  /business/time-entries/bulk`` — bulk upsert. The frontend sends the
  full ``(work_date, hours)`` set for the visible month; the API inserts new
  rows, updates rows whose hours changed, and deletes rows whose hours dropped
  to zero. Rows that have already been invoiced (``invoice_id IS NOT NULL``)
  are read-only and the upsert silently skips them.

V1 invariant: exactly one ``time_entries`` row per ``(client_id, work_date)``
(enforced by ``time_entries_client_work_date_unique`` in the DB).
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app import db
from app.deps import get_current_user
from app.models.time_entries import TimeEntryRead

router = APIRouter(tags=["time-entries"], dependencies=[Depends(get_current_user)])


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class TimeEntryBulkItem(BaseModel):
    """One ``(work_date, hours)`` pair sent to the bulk upsert endpoint."""

    work_date: date
    hours: Decimal


class TimeEntryBulkRequest(BaseModel):
    """Body for ``PUT /business/time-entries/bulk``.

    Attributes:
        client_id: Client whose timesheet is being saved.
        entries: All ``(work_date, hours)`` pairs the frontend wants to
            persist. Hours of zero (or missing dates within the period — see
            ``period_start``/``period_end``) cause the corresponding row to
            be deleted.
        period_start: Inclusive start of the period being saved. Anything
            within ``[period_start, period_end]`` not present in
            ``entries`` (or with hours == 0) is deleted.
        period_end: Inclusive end of the period being saved.
    """

    client_id: UUID
    entries: list[TimeEntryBulkItem]
    period_start: date
    period_end: date


# ---------------------------------------------------------------------------
# GET /business/time-entries
# ---------------------------------------------------------------------------


@router.get(
    "/",
    response_model=list[TimeEntryRead],
    summary="List time entries for a client over a date range",
)
async def list_time_entries(
    client_id: UUID = Query(..., description="Client UUID to fetch entries for."),
    start: date = Query(..., description="Inclusive start date (YYYY-MM-DD)."),
    end: date = Query(..., description="Inclusive end date (YYYY-MM-DD)."),
) -> list[TimeEntryRead]:
    """Return time entries for a client between ``start`` and ``end``.

    Sorted by ``work_date`` ascending so the frontend can populate the grid
    in calendar order without re-sorting.
    """
    rows = db.fetch_all(
        """
        SELECT * FROM time_entries
        WHERE client_id = :client_id
          AND work_date BETWEEN :start AND :end
        ORDER BY work_date ASC
        """,
        {"client_id": client_id, "start": start, "end": end},
    )
    return [TimeEntryRead(**row) for row in rows]


# ---------------------------------------------------------------------------
# PUT /business/time-entries/bulk
# ---------------------------------------------------------------------------


@router.put(
    "/bulk",
    response_model=list[TimeEntryRead],
    summary="Bulk upsert time entries for a single client and period",
)
async def bulk_upsert_time_entries(
    body: TimeEntryBulkRequest,
) -> list[TimeEntryRead]:
    """Replace the time entries for ``client_id`` over the given period.

    Behaviour:

    * Rows in ``body.entries`` with ``hours > 0`` are upserted.
    * Rows in ``body.entries`` with ``hours == 0`` are deleted.
    * Existing rows in ``[period_start, period_end]`` not mentioned in
      ``body.entries`` are also deleted (so the frontend can stay
      authoritative for the visible window).
    * Rows that already belong to an invoice
      (``invoice_id IS NOT NULL``) are immutable: the upsert silently
      skips them and they are not deleted either.

    Returns the full set of entries (after the operation) for the
    requested period.
    """
    if body.period_start > body.period_end:
        raise HTTPException(
            status_code=400,
            detail="period_start must be <= period_end",
        )

    sent_dates = {item.work_date for item in body.entries}

    # 1. Delete entries inside [period_start, period_end] that are either
    #    explicitly zero in the request, or were not sent at all. Skip
    #    invoiced rows. We can't easily build a parameterised IN-list with
    #    the Data API, so issue per-date deletes for the explicit zeros and
    #    a single sweep for "missing" dates.
    zero_dates = {item.work_date for item in body.entries if item.hours == 0}
    for work_date in zero_dates:
        db.execute(
            """
            DELETE FROM time_entries
            WHERE client_id = :client_id
              AND work_date = :work_date
              AND invoice_id IS NULL
            """,
            {"client_id": body.client_id, "work_date": work_date},
        )

    # Sweep: anything in the period that wasn't explicitly sent at all.
    if sent_dates:
        # Build a NOT IN list of date literals — values come from a closed
        # numeric set we control (calendar dates), no injection surface.
        not_in_clause = ",".join(f"'{d.isoformat()}'" for d in sent_dates)
        db.execute(
            f"""
            DELETE FROM time_entries
            WHERE client_id = :client_id
              AND work_date BETWEEN :start AND :end
              AND invoice_id IS NULL
              AND work_date NOT IN ({not_in_clause})
            """,
            {
                "client_id": body.client_id,
                "start": body.period_start,
                "end": body.period_end,
            },
        )
    else:
        # No entries sent at all → wipe the whole period (uninvoiced only).
        db.execute(
            """
            DELETE FROM time_entries
            WHERE client_id = :client_id
              AND work_date BETWEEN :start AND :end
              AND invoice_id IS NULL
            """,
            {
                "client_id": body.client_id,
                "start": body.period_start,
                "end": body.period_end,
            },
        )

    # 2. Upsert non-zero entries. ON CONFLICT relies on the unique index
    #    on (client_id, work_date). If the existing row is invoiced the
    #    WHERE clause on the DO UPDATE prevents the overwrite.
    now = datetime.now(timezone.utc)
    for item in body.entries:
        if item.hours == 0:
            continue
        db.execute(
            """
            INSERT INTO time_entries (
                id, client_id, work_date, hours, invoice_id,
                created_at, updated_at
            ) VALUES (
                :id, :client_id, :work_date, :hours, NULL,
                :now, :now
            )
            ON CONFLICT (client_id, work_date) DO UPDATE SET
                hours = EXCLUDED.hours,
                updated_at = EXCLUDED.updated_at
            WHERE time_entries.invoice_id IS NULL
            """,
            {
                "id": uuid4(),
                "client_id": body.client_id,
                "work_date": item.work_date,
                "hours": item.hours,
                "now": now,
            },
        )

    # 3. Return the resulting set for the period.
    rows = db.fetch_all(
        """
        SELECT * FROM time_entries
        WHERE client_id = :client_id
          AND work_date BETWEEN :start AND :end
        ORDER BY work_date ASC
        """,
        {
            "client_id": body.client_id,
            "start": body.period_start,
            "end": body.period_end,
        },
    )
    return [TimeEntryRead(**row) for row in rows]
