"""Pydantic models for the ``settings`` table.

Mirrors the Drizzle schema in ``db/schema/settings.ts``.

Settings are stored as a flat key/value table. The PK is ``key`` (a text
string), not a UUID. Known V1 keys: ``gst_rate``, ``default_currency``.
Values are stored as TEXT and parsed at the application layer.

Note: this table's PK is ``key`` (text), not a UUID ``id``. The ``Read``
model therefore exposes ``key`` rather than ``id``, and has only
``updated_at`` (no ``created_at`` in the Drizzle schema).
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class SettingBase(BaseModel):
    """Shared data fields for an application setting (no timestamps).

    Attributes:
        key: Setting key (primary key). Examples: ``"gst_rate"``,
            ``"default_currency"``.
        value: Setting value as a text string. Parsed by the application.
    """

    key: str
    value: str


class SettingCreate(SettingBase):
    """Request body for creating or upserting an application setting.

    Inherits all fields from :class:`SettingBase`.
    """


class SettingRead(SettingBase):
    """Response model for reading an application setting.

    Extends :class:`SettingBase` with the server-managed timestamp.

    Attributes:
        updated_at: Timestamp when the setting was last updated (UTC).
    """

    model_config = ConfigDict(from_attributes=True)

    updated_at: datetime


class SettingUpdate(BaseModel):
    """Request body for partially updating an application setting (PATCH).

    Only ``value`` can change; ``key`` is the primary key and is immutable.
    """

    value: str | None = None
