"""Application configuration via pydantic-settings.

Settings are loaded from environment variables (prefixed with HELM_) and
optionally from a .env file. All settings have sensible defaults for local
development.
"""

from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings.

    Loaded from environment variables prefixed with ``HELM_`` and from a
    ``.env`` file in the working directory (if present).

    Attributes:
        database_name: Name of the Aurora database. Defaults to ``"helm"``.
        database_secret_arn: ARN of the Secrets Manager secret holding Aurora
            credentials. ``None`` when running locally (no DB connection).
        database_resource_arn: ARN of the Aurora cluster resource. ``None``
            when running locally.
        stage: Deployment stage. One of ``"dev"``, ``"prod"``, or ``"local"``.
    """

    database_name: str = "helm"
    database_secret_arn: str | None = None
    database_resource_arn: str | None = None
    stage: Literal["dev", "prod", "local"] = "local"

    # S3 bucket that stores uploaded receipt/invoice images. Set via
    # ``HELM_RECEIPTS_BUCKET``; ``None`` locally means presigned-URL
    # endpoints raise instead of returning bogus URLs.
    receipts_bucket: str | None = None

    # Secrets Manager ARN holding the user's YNAB Personal Access Token.
    # The API Lambda reads + writes this secret to power the Money module.
    # ``None`` locally means YNAB endpoints raise with a clear error
    # rather than silently no-op.
    ynab_secret_arn: str | None = None

    model_config = SettingsConfigDict(
        env_prefix="HELM_",
        env_file=".env",
        extra="ignore",
    )


settings = Settings()
