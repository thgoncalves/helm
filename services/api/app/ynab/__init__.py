"""YNAB integration package.

Owns:

* :mod:`app.ynab.client` — thin httpx wrapper for the YNAB API.
* :mod:`app.ynab.token` — Personal Access Token storage in Secrets Manager.
* :mod:`app.ynab.sync` — refresh-on-demand upsert into the Postgres cache.
"""
