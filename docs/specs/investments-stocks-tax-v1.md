# Investments — Stocks: Sell + Tax-Time V1

**Status**: parked stub · written during `feat/investing-stocks` so
future-us doesn't re-research the CRA rules.

## The "remember about this" the user flagged

When you sell stock you trigger a taxable event. The whole point of
tracking lots and ACB now is to make that calculation correct later.

## Canadian capital-gains rules (non-registered accounts)

```
gross_proceeds   = quantity_sold × sell_price
commissions      = sell fees
net_proceeds     = gross_proceeds - commissions
acb_on_sold      = quantity_sold × adjusted_cost_base_per_share
capital_gain     = net_proceeds - acb_on_sold
taxable_amount   = capital_gain × 0.50          # 50% inclusion rate
```

- **ACB is per (account, ticker)** for CRA purposes, recomputed every
  time you buy more (weighted average). Identical stocks in different
  accounts are tracked independently.
- **Superficial-loss rule**: if you sell at a loss and buy back the
  same security within 30 days (before *or* after), the loss is
  denied and instead added to the new lot's ACB. Worth surfacing as a
  warning on the sell form.
- **T5008 reporting**: the broker reports proceeds + (sometimes) ACB
  to CRA. Our number should match — if it doesn't, we want a "why"
  field on the sell row.

## TFSA / RRSP

- **TFSA**: no tax on gains, ever. No ACB tracking needed. Capital
  losses can't be claimed.
- **RRSP**: gains tax-deferred. Withdrawals are taxed as income, not
  capital gains. ACB irrelevant.

We already capture this via `investment_accounts.kind`; the sell flow
just skips the gain calculation when `kind in ('tfsa', 'rrsp')`.

## Foreign exchange (USD trades in a CAD account)

For non-registered, CRA wants gains computed in **CAD**, with:
- Buy price translated to CAD at the trade-date FX
- Sell price translated to CAD at the trade-date FX

So a USD-flat trade can still produce a CAD gain or loss purely from
FX movement. Our `fx_rates` cache + `transaction_date` on each lot is
enough — we just need to compute ACB in CAD, not in the trade currency.

## Foreign withholding tax on dividends (when we get to dividends)

US dividends paid to a Canadian holder are withheld at 15% under the
US-Canada treaty (assuming the broker filed W-8BEN). Withheld amount
is claimable as a foreign tax credit on the Canadian return.

- TFSA holdings of US stocks: 15% withheld and **not recoverable** (TFSA
  is not a recognized treaty vehicle). Often a flag on the position.
- RRSP holdings of US stocks: withholding is waived under the treaty.

## What V1.5+ needs to build (sell flow)

- `transaction_type = "sell"` rows in `stock_transactions`
- `sells` route that takes proceeds + commissions and computes the
  capital gain using the position's current ACB
- A capital-gains report by tax year (start with calendar year)
- The superficial-loss warning above
- FX translation pulled from `fx_rates` at trade date

## What V1 should leave in place for this

- `stock_transactions` is already shaped to accept `"sell"` rows
- `transaction_date` is captured, so FX translation has its anchor
- `fees` is captured (commissions on sell)
- `currency` is per-transaction, so USD/CAD/BRL all flow through

Nothing in V1 has to change to make V1.5 possible.
