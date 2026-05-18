"""Money module — health KPIs, snapshots, and the shared balance aggregator.

The router lives at :mod:`app.routers.money_health`; this package holds
the logic it delegates to (balance aggregation, snapshot capture). Two
modules import :mod:`app.money.balances`: the live health endpoint and
the snapshot writer that runs from the various account write paths.
"""
