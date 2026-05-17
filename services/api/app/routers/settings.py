"""FastAPI router for the ``/business/settings`` endpoints.

V1 settings are stored as a flat key/value table (see ``db/schema/settings.ts``).
This router exposes a bulk GET that returns the whole map and a bulk PUT
that upserts a subset of keys — the Settings page sends only what the
user changed, but supporting full replacement would also work.

Endpoints:

* ``GET /business/settings/`` — returns ``{key: value}`` for every row.
* ``PUT /business/settings/`` — body is ``{key: value}``; each pair is
  upserted (``ON CONFLICT (key) DO UPDATE``). Returns the freshly
  re-read full map so the frontend stays in sync after save.
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import RootModel

from app import db
from app.deps import get_current_user

router = APIRouter(tags=["settings"], dependencies=[Depends(get_current_user)])


class SettingsMap(RootModel[dict[str, str]]):
    """A flat ``{key: value}`` map of settings."""

    root: dict[str, str]


def _read_all() -> dict[str, str]:
    rows = db.fetch_all("SELECT key, value FROM settings ORDER BY key")
    return {r["key"]: r["value"] for r in rows}


@router.get(
    "/",
    response_model=SettingsMap,
    summary="Return all settings as a key/value map",
)
async def get_settings() -> SettingsMap:
    return SettingsMap(_read_all())


@router.put(
    "/",
    response_model=SettingsMap,
    summary="Bulk-upsert settings; body is {key: value}",
)
async def put_settings(body: SettingsMap) -> SettingsMap:
    now = datetime.now(timezone.utc)
    for key, value in body.root.items():
        db.execute(
            """
            INSERT INTO settings (key, value, updated_at)
            VALUES (:key, :value, :now)
            ON CONFLICT (key) DO UPDATE
                SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
            """,
            {"key": key, "value": value, "now": now},
        )
    return SettingsMap(_read_all())
