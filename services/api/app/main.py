"""FastAPI application entry point.

Constructs the FastAPI app, configures CORS, mounts routers, and exposes
a Mangum handler for AWS Lambda.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from mangum import Mangum

from app.routers import accounts as accounts_router
from app.routers import accounts_manual as accounts_manual_router
from app.routers import clients as clients_router
from app.routers import dashboard as dashboard_router
from app.routers import expenses as expenses_router
from app.routers import investments_accounts as investments_accounts_router
from app.routers import (
    investments_contributions as investments_contributions_router,
)
from app.routers import investments_holdings as investments_holdings_router
from app.routers import investments_portfolio as investments_portfolio_router
from app.routers import investments_stocks as investments_stocks_router
from app.routers import investments_targets as investments_targets_router
from app.routers import invoices as invoices_router
from app.routers import money_health as money_health_router
from app.routers import money_ynab as money_ynab_router
from app.routers import payments as payments_router
from app.routers import settings as settings_router
from app.routers import tax_payments as tax_payments_router
from app.routers import time_entries as time_entries_router
from app.routers import timesheets as timesheets_router
from app.routers import transfers as transfers_router

app = FastAPI(
    title="Helm API",
    version="0.0.0",
    description=(
        "Business and personal finance API for the Helm application. "
        "Deployed to AWS Lambda via Mangum behind API Gateway with a "
        "Cognito JWT authoriser."
    ),
)

# ---------------------------------------------------------------------------
# CORS — permissive for development. Tighten in production via config.
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(clients_router.router, prefix="/business/clients")
app.include_router(dashboard_router.router, prefix="/business/dashboard")
app.include_router(expenses_router.router, prefix="/business/expenses")
app.include_router(invoices_router.router, prefix="/business/invoices")
app.include_router(payments_router.router, prefix="/business/payments")
app.include_router(settings_router.router, prefix="/business/settings")
app.include_router(tax_payments_router.router, prefix="/business/tax-payments")
app.include_router(time_entries_router.router, prefix="/business/time-entries")
app.include_router(timesheets_router.router, prefix="/business/timesheets")
app.include_router(transfers_router.router, prefix="/business/transfers")

# Money — YNAB integration + health-first dashboard.
app.include_router(money_ynab_router.router, prefix="/money")
app.include_router(money_health_router.router, prefix="/money")

# Investments — portfolio tracker (V1). Four sub-routers behind one prefix.
app.include_router(
    investments_accounts_router.router, prefix="/investments/accounts"
)
app.include_router(
    investments_holdings_router.router, prefix="/investments/holdings"
)
app.include_router(
    investments_targets_router.router, prefix="/investments/targets"
)
app.include_router(
    investments_portfolio_router.router, prefix="/investments/portfolio"
)
# Contributions router declares its own /accounts/{id}/contributions
# and /contributions/room paths, so it mounts directly under /investments.
app.include_router(
    investments_contributions_router.router, prefix="/investments"
)
# Stocks V1 — search, detail, transactions, refresh-quote.
app.include_router(
    investments_stocks_router.router, prefix="/investments/stocks"
)

# Accounts — cross-cutting management page. Manual-accounts CRUD lives
# at /accounts/manual; the aggregator + tagging + YNAB sync alias mount
# at /accounts root.
app.include_router(accounts_manual_router.router)
app.include_router(accounts_router.router)

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


@app.get("/health", tags=["ops"], summary="Health check")
async def health() -> dict[str, str]:
    """Return a simple liveness probe response.

    Returns:
        ``{"status": "ok"}`` — always, as long as the process is alive.
    """
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Lambda handler — module-level so Lambda can find it as ``app.main.handler``.
# ---------------------------------------------------------------------------
handler = Mangum(app)
