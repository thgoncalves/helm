"""FastAPI dependency functions.

Provides reusable dependencies for auth and (future) database access.
"""

from fastapi import Request

_DEV_USER_ID = "00000000-0000-0000-0000-000000000000"


async def get_current_user(request: Request) -> str:
    """Return the authenticated Cognito user's ``sub`` claim.

    When deployed behind API Gateway with a Cognito JWT authoriser, the
    validated claims are injected into the Lambda event's ``requestContext``.
    Mangum surfaces that event at ``request.scope["aws.event"]``.

    When running locally (no Lambda event), falls back to a hardcoded dev UUID
    so development and testing work without real auth infrastructure.

    Args:
        request: The incoming FastAPI request.

    Returns:
        The Cognito ``sub`` UUID string for the authenticated user, or the
        hardcoded dev UUID ``"00000000-0000-0000-0000-000000000000"`` when no
        Lambda context is present.
    """
    aws_event: dict = request.scope.get("aws.event", {})
    sub: str | None = (
        aws_event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
        .get("sub")
    )
    return sub if sub is not None else _DEV_USER_ID
