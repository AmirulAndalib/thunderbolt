"""Microsoft (formerly Outlook) OAuth router.

Endpoints are namespaced under ``/auth/microsoft`` so the frontend can be
implemented immediately while backend logic is pending.
"""

from functools import lru_cache
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import Settings

router = APIRouter(prefix="/auth/microsoft", tags=["auth-microsoft"])


@lru_cache
def get_settings() -> Settings:
    return Settings()


class CodeRequest(BaseModel):
    code: str
    code_verifier: str
    redirect_uri: str


class RefreshRequest(BaseModel):
    refresh_token: str


@router.get("/config")
async def oauth_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Return public Microsoft OAuth configuration for the frontend."""

    return {
        "client_id": settings.microsoft_client_id,
        "configured": bool(
            settings.microsoft_client_id and settings.microsoft_client_secret
        ),
    }


@router.post("/exchange")
async def exchange_code(_: CodeRequest) -> None:  # pragma: no cover – placeholder
    """Exchange code for tokens (not yet implemented)."""

    raise HTTPException(
        status_code=501, detail="Microsoft OAuth exchange not yet implemented"
    )


@router.post("/refresh")
async def refresh_token(_: RefreshRequest) -> None:  # pragma: no cover
    """Refresh token (not yet implemented)."""

    raise HTTPException(
        status_code=501, detail="Microsoft OAuth refresh not yet implemented"
    )
