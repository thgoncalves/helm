"""FastAPI router for the ``/personal/imports`` endpoints.

CSV upload pipeline:

  POST /personal/imports/  → row in 'pending' + presigned PUT URL
  PUT  {url}               → file lands in S3 under imports/<yyyy-mm>/<uuid>.csv
  S3 ObjectCreated event   → app.handlers.process_csv.handler runs
                              the institution-specific parser and inserts
                              transactions
  GET  /personal/imports/  → list (status / counts / errors visible)
"""

from datetime import date, datetime, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException

from app import aws, db
from app.config import settings
from app.deps import get_current_user
from app.models.personal_imports import (
    PersonalImportCreateRequest,
    PersonalImportCreateResponse,
    PersonalImportRead,
)

router = APIRouter(
    tags=["personal-imports"], dependencies=[Depends(get_current_user)]
)

_UPLOAD_EXPIRY_SEC = 5 * 60


def _require_bucket() -> str:
    if not settings.receipts_bucket:
        raise HTTPException(
            status_code=500,
            detail=(
                "HELM_RECEIPTS_BUCKET not configured. Same bucket is reused "
                "for the imports/ prefix."
            ),
        )
    return settings.receipts_bucket


def _build_s3_key(today: date, import_id: UUID) -> str:
    return f"imports/{today:%Y-%m}/{import_id}.csv"


@router.post(
    "/",
    response_model=PersonalImportCreateResponse,
    status_code=201,
    summary="Reserve an import row and get a presigned PUT URL for the CSV",
)
async def create_import(
    body: PersonalImportCreateRequest,
) -> PersonalImportCreateResponse:
    bucket = _require_bucket()
    # Confirm the account exists (FK protection — the SQL FK does it too
    # but a cleaner 404 is friendlier).
    account = db.fetch_one(
        "SELECT id FROM personal_accounts WHERE id = :id",
        {"id": body.account_id},
    )
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")

    now = datetime.now(timezone.utc)
    import_id = uuid4()
    s3_key = _build_s3_key(now.date(), import_id)

    row = db.fetch_one(
        """
        INSERT INTO personal_imports (
            id, account_id, institution, status, s3_key, filename,
            size_bytes, created_at, updated_at
        ) VALUES (
            :id, :account_id, :institution, 'pending', :s3_key, :filename,
            :size_bytes, :now, :now
        )
        RETURNING *
        """,
        {
            "id": import_id,
            "account_id": body.account_id,
            "institution": body.institution,
            "s3_key": s3_key,
            "filename": body.filename,
            "size_bytes": body.size_bytes,
            "now": now,
        },
    )
    assert row is not None

    upload_url = aws.s3().generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": bucket, "Key": s3_key},
        ExpiresIn=_UPLOAD_EXPIRY_SEC,
    )

    return PersonalImportCreateResponse(
        import_=PersonalImportRead(**row),
        upload_url=upload_url,
    )


@router.get(
    "/",
    response_model=list[PersonalImportRead],
    summary="List CSV imports",
)
async def list_imports() -> list[PersonalImportRead]:
    rows = db.fetch_all(
        """
        SELECT * FROM personal_imports
        ORDER BY created_at DESC
        """,
    )
    return [PersonalImportRead(**r) for r in rows]


@router.get(
    "/{import_id}",
    response_model=PersonalImportRead,
    summary="Get a single import",
)
async def get_import(import_id: UUID) -> PersonalImportRead:
    row = db.fetch_one(
        "SELECT * FROM personal_imports WHERE id = :id",
        {"id": import_id},
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Import not found")
    return PersonalImportRead(**row)
