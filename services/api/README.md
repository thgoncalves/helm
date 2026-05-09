# `services/api`

FastAPI backend for Helm, deployed to AWS Lambda via **Mangum**. Sits behind
API Gateway HTTP API with a Cognito JWT authoriser.

## Layout

```
services/api/
├── app/
│   ├── routers/
│   │   ├── __init__.py
│   │   └── clients.py       # GET + POST /business/clients (in-memory stub)
│   ├── models/
│   │   ├── __init__.py      # Re-exports all model classes
│   │   ├── clients.py
│   │   ├── invoices.py
│   │   ├── invoice_line_items.py
│   │   ├── invoice_tax_links.py
│   │   ├── payments_received.py
│   │   ├── settings.py
│   │   ├── tax_ledger.py
│   │   ├── tax_payments.py
│   │   ├── time_entries.py
│   │   └── transfers.py
│   ├── config.py            # pydantic-settings Settings (HELM_ prefix)
│   ├── deps.py              # get_current_user dependency
│   └── main.py              # FastAPI app + Mangum handler
├── tests/
│   ├── conftest.py          # TestClient fixture
│   ├── test_models.py       # Pydantic model unit tests
│   └── test_clients_router.py  # Router integration tests
├── pyproject.toml           # Managed with uv
├── uv.lock
└── Dockerfile               # Lambda container image
```

## Running locally

```sh
# Install all dependencies (runtime + dev)
uv sync

# Start the dev server with hot-reload
uv run uvicorn app.main:app --reload
```

The API will be available at `http://localhost:8000`. Interactive docs at
`http://localhost:8000/docs`.

## Running tests

```sh
uv run pytest -v
```

## What is stubbed / not yet implemented

- **No database connection.** All data is in-memory. The `GET /business/clients`
  and `POST /business/clients` endpoints return and accept hardcoded or
  process-lifetime data only. When the DB layer is added it will use the
  RDS Data API via `boto3` (`app/db.py`, not yet created).

- **In-memory `/clients` data.** Two hardcoded `ClientRead` instances are
  pre-loaded at startup. `POST /business/clients` appends to that list for
  the lifetime of the process; data is lost on restart.

- **Hardcoded dev user.** `app/deps.py::get_current_user` reads the Cognito
  `sub` claim from the API Gateway Lambda event context. When that context is
  absent (local dev, tests), it falls back to
  `"00000000-0000-0000-0000-000000000000"`.

- **Other routers not implemented yet.** Only `clients` exists. All other
  business endpoints (`/invoices`, `/timesheets`, `/payments`, etc.) are
  planned but not scaffolded.

## What's next

1. Add `app/db.py` — RDS Data API client via `boto3`.
2. Replace in-memory stub in `routers/clients.py` with real queries.
3. Scaffold remaining routers: invoices, time entries, payments, taxes,
   transfers, settings.
4. Add `scripts/gen-api-types.sh` to regenerate TypeScript types from
   `openapi.json`.

## Type sharing with the frontend

FastAPI auto-generates OpenAPI JSON at `/openapi.json`. Running
`scripts/gen-api-types.sh` (in the repo root `scripts/`) pipes that through
`openapi-typescript` to produce committed TypeScript types in
`packages/shared/api-types/`. Regenerate on every API schema change.

## Auth

The Cognito JWT authoriser at API Gateway validates the token before the
Lambda is invoked. FastAPI reads identity from the request context's
authorised claims — no JWT validation in app code.
