"""FastAPI router for the ``/business/expenses`` endpoints.

V1 flow:

1. ``POST /business/expenses/`` — creates a row in ``status='pending'``
   and returns a presigned PUT URL the browser uses to upload the
   photo straight to S3 (avoids Lambda's 6 MB body limit).
2. The S3 ``ObjectCreated:*`` event triggers the
   :mod:`app.handlers.process_receipt` Lambda which runs Textract and
   updates the row to ``ready`` / ``failed``.
3. The frontend polls ``GET /business/expenses/`` every 3 s while any
   row is still ``processing``; polling stops once everything settles.
4. ``GET /business/expenses/{id}/image-url`` returns a presigned GET URL
   so the form can render the uploaded image inline.
"""

from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Query

from app import aws, db
from app.config import settings
from app.deps import get_current_user
from app.models.expenses import (
    ExpenseCreateRequest,
    ExpenseCreateResponse,
    ExpenseImageUrlResponse,
    ExpenseRead,
    ExpenseUpdate,
)

router = APIRouter(tags=["expenses"], dependencies=[Depends(get_current_user)])

# Presigned URL lifetime — long enough for the user to confirm "Take
# Photo" + upload over a slow mobile network, short enough that a
# stolen URL can't be replayed indefinitely.
_UPLOAD_EXPIRY_SEC = 5 * 60
_DOWNLOAD_EXPIRY_SEC = 5 * 60


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_bucket() -> str:
    if not settings.receipts_bucket:
        raise HTTPException(
            status_code=500,
            detail=(
                "HELM_RECEIPTS_BUCKET not configured. Set it in the Lambda "
                "environment via CDK (api-stack.ts)."
            ),
        )
    return settings.receipts_bucket


def _fetch_or_404(expense_id: UUID) -> dict:
    row = db.fetch_one(
        "SELECT * FROM expenses WHERE id = :id",
        {"id": expense_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Expense not found")
    return row


def _build_s3_key(today: date, expense_id: UUID, extension: str) -> str:
    """Stable layout: ``expenses/<yyyy-mm>/<uuid>.<ext>``.

    The yyyy-mm prefix groups objects for cheaper lifecycle / browsing.
    Extension comes from the client; we strip a leading dot if present.
    """
    safe_ext = (extension or "jpg").lstrip(".").lower()[:5] or "jpg"
    return f"expenses/{today:%Y-%m}/{expense_id}.{safe_ext}"


# ---------------------------------------------------------------------------
# POST /  — create row + presigned PUT
# ---------------------------------------------------------------------------


@router.post(
    "/",
    response_model=ExpenseCreateResponse,
    status_code=201,
    summary="Reserve an expense row and get a presigned PUT URL for the photo",
)
async def create_expense(body: ExpenseCreateRequest) -> ExpenseCreateResponse:
    bucket = _require_bucket()
    now = datetime.now(timezone.utc)
    expense_id = uuid4()
    s3_key = _build_s3_key(now.date(), expense_id, body.file_extension)

    row = db.fetch_one(
        """
        INSERT INTO expenses (
            id, status, s3_key, content_type, size_bytes, currency,
            created_at, updated_at
        ) VALUES (
            :id, 'pending', :s3_key, :content_type, :size_bytes, 'CAD',
            :now, :now
        )
        RETURNING *
        """,
        {
            "id": expense_id,
            "s3_key": s3_key,
            "content_type": body.content_type,
            "size_bytes": body.size_bytes,
            "now": now,
        },
    )
    assert row is not None

    # Don't bind Content-Type into the signed URL. iOS Safari and
    # Chrome on Android sometimes massage the Content-Type header
    # between the form-upload event and the actual fetch (e.g.
    # ``image/heic`` → ``image/jpeg`` after a transparent conversion),
    # which makes the signature mismatch and S3 rejects the PUT with
    # a 403 that surfaces as "Load failed" on Safari.
    #
    # We still record the client-supplied content_type in the DB so the
    # processor knows what it's dealing with — it's just not part of
    # the URL signature.
    upload_url = aws.s3().generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": bucket, "Key": s3_key},
        ExpiresIn=_UPLOAD_EXPIRY_SEC,
    )
    return ExpenseCreateResponse(
        expense=ExpenseRead(**row),
        upload_url=upload_url,
    )


# ---------------------------------------------------------------------------
# GET /  — list with filters
# ---------------------------------------------------------------------------


@router.get(
    "/",
    response_model=list[ExpenseRead],
    summary="List expenses with optional date-range and status filters",
)
async def list_expenses(
    from_date: date | None = Query(None, alias="from"),
    to_date: date | None = Query(None, alias="to"),
    status: str | None = Query(None),
) -> list[ExpenseRead]:
    where: list[str] = []
    params: dict = {}
    if from_date is not None:
        where.append("expense_date >= :from_date")
        params["from_date"] = from_date
    if to_date is not None:
        where.append("expense_date <= :to_date")
        params["to_date"] = to_date
    if status is not None:
        where.append("status = :status")
        params["status"] = status
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    rows = db.fetch_all(
        f"""
        SELECT * FROM expenses
        {where_sql}
        ORDER BY COALESCE(expense_date, created_at::date) DESC, created_at DESC
        """,
        params,
    )
    return [ExpenseRead(**r) for r in rows]


# ---------------------------------------------------------------------------
# GET /{id}
# ---------------------------------------------------------------------------


@router.get(
    "/{expense_id}",
    response_model=ExpenseRead,
    summary="Get a single expense",
)
async def get_expense(expense_id: UUID) -> ExpenseRead:
    return ExpenseRead(**_fetch_or_404(expense_id))


# ---------------------------------------------------------------------------
# GET /{id}/image-url
# ---------------------------------------------------------------------------


@router.get(
    "/{expense_id}/image-url",
    response_model=ExpenseImageUrlResponse,
    summary="Presigned GET URL to render the uploaded image",
)
async def get_image_url(expense_id: UUID) -> ExpenseImageUrlResponse:
    bucket = _require_bucket()
    row = _fetch_or_404(expense_id)
    url = aws.s3().generate_presigned_url(
        ClientMethod="get_object",
        Params={"Bucket": bucket, "Key": row["s3_key"]},
        ExpiresIn=_DOWNLOAD_EXPIRY_SEC,
    )
    return ExpenseImageUrlResponse(url=url)


# ---------------------------------------------------------------------------
# PUT /{id}  — user edits (OCR may have got it wrong)
# ---------------------------------------------------------------------------


@router.put(
    "/{expense_id}",
    response_model=ExpenseRead,
    summary="Update an expense's user-editable fields",
)
async def update_expense(
    expense_id: UUID, body: ExpenseUpdate
) -> ExpenseRead:
    _fetch_or_404(expense_id)
    now = datetime.now(timezone.utc)
    row = db.fetch_one(
        """
        UPDATE expenses SET
            expense_date = :expense_date,
            supplier = :supplier,
            category = :category,
            subtotal = :subtotal,
            tax_amount = :tax_amount,
            total = :total,
            currency = :currency,
            notes = :notes,
            updated_at = :updated_at
        WHERE id = :id
        RETURNING *
        """,
        {
            "id": expense_id,
            "expense_date": body.expense_date,
            "supplier": body.supplier,
            "category": body.category,
            "subtotal": body.subtotal,
            "tax_amount": body.tax_amount,
            "total": body.total,
            "currency": body.currency or "CAD",
            "notes": body.notes,
            "updated_at": now,
        },
    )
    assert row is not None
    return ExpenseRead(**row)


# ---------------------------------------------------------------------------
# DELETE /{id}  — drops the row + the S3 object
# ---------------------------------------------------------------------------


@router.delete(
    "/{expense_id}",
    status_code=204,
    summary="Delete an expense and remove the uploaded image from S3",
)
async def delete_expense(expense_id: UUID) -> None:
    bucket = _require_bucket()
    existing = _fetch_or_404(expense_id)
    db.execute(
        "DELETE FROM expenses WHERE id = :id",
        {"id": expense_id},
    )
    # Best-effort S3 cleanup. boto3.delete_object is idempotent (succeeds
    # even if the object isn't there), so we don't gate the DB delete on
    # it succeeding — the row going away matters more than the image.
    try:
        aws.s3().delete_object(Bucket=bucket, Key=existing["s3_key"])
    except Exception:
        # Silent — we don't want a transient S3 hiccup to leave the row
        # behind. CloudWatch will surface persistent issues.
        pass
