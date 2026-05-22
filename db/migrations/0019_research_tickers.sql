-- Stocks Research V1: curated universe of tickers for the new Research
-- tab. Seed data follows in 0020_seed_research_tickers.sql so this
-- migration can roll forward and back independently of the seed.
CREATE TABLE research_tickers (
  ticker      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  sector      TEXT NOT NULL,
  industry    TEXT,
  country     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);--> statement-breakpoint
CREATE INDEX research_tickers_sector_idx ON research_tickers(sector);
