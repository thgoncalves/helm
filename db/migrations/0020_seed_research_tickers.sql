-- Seed the Research universe with ~55 curated tickers (US + TSX).
-- See docs/specs/investments-research-v1.md for the source list.
--
-- sort_order is grouped: 0-99 ETFs, 100s Technology, 200s Financials,
-- etc. — so future inserts can slot in without renumbering. Within a
-- sector tickers are alphabetical.
INSERT INTO research_tickers (ticker, name, sector, industry, country, sort_order) VALUES
  -- ETFs
  ('SPY',     'SPDR S&P 500 ETF Trust',                'ETF', 'Broad US Market',   'US',   0),
  ('VOO',     'Vanguard S&P 500 ETF',                  'ETF', 'Broad US Market',   'US',   1),
  ('QQQ',     'Invesco QQQ Trust',                     'ETF', 'US Tech / Nasdaq',  'US',   2),
  ('VTI',     'Vanguard Total Stock Market ETF',       'ETF', 'Total US Market',   'US',   3),

  -- Technology
  ('AAPL',    'Apple Inc.',                            'Technology', 'Consumer Electronics',  'US', 100),
  ('ADBE',    'Adobe Inc.',                            'Technology', 'Software',              'US', 101),
  ('AMZN',    'Amazon.com Inc.',                       'Technology', 'Internet Retail',       'US', 102),
  ('AVGO',    'Broadcom Inc.',                         'Technology', 'Semiconductors',        'US', 103),
  ('CRM',     'Salesforce Inc.',                       'Technology', 'Software',              'US', 104),
  ('GOOGL',   'Alphabet Inc. (Class A)',               'Technology', 'Internet Content',      'US', 105),
  ('META',    'Meta Platforms Inc.',                   'Technology', 'Internet Content',      'US', 106),
  ('MSFT',    'Microsoft Corporation',                 'Technology', 'Software',              'US', 107),
  ('NVDA',    'NVIDIA Corporation',                    'Technology', 'Semiconductors',        'US', 108),
  ('ORCL',    'Oracle Corporation',                    'Technology', 'Software',              'US', 109),
  ('SHOP.TO', 'Shopify Inc.',                          'Technology', 'Software',              'CA', 110),

  -- Financials
  ('BAC',     'Bank of America Corp.',                 'Financials', 'Banks',                 'US', 200),
  ('BNS.TO',  'Bank of Nova Scotia',                   'Financials', 'Banks',                 'CA', 201),
  ('BMO.TO',  'Bank of Montreal',                      'Financials', 'Banks',                 'CA', 202),
  ('BRK.B',   'Berkshire Hathaway Inc. (Class B)',     'Financials', 'Diversified Holdings',  'US', 203),
  ('CM.TO',   'Canadian Imperial Bank of Commerce',    'Financials', 'Banks',                 'CA', 204),
  ('GS',      'Goldman Sachs Group Inc.',              'Financials', 'Investment Banking',    'US', 205),
  ('JPM',     'JPMorgan Chase & Co.',                  'Financials', 'Banks',                 'US', 206),
  ('MA',      'Mastercard Incorporated',               'Financials', 'Payments',              'US', 207),
  ('RY.TO',   'Royal Bank of Canada',                  'Financials', 'Banks',                 'CA', 208),
  ('TD.TO',   'Toronto-Dominion Bank',                 'Financials', 'Banks',                 'CA', 209),
  ('V',       'Visa Inc.',                             'Financials', 'Payments',              'US', 210),

  -- Healthcare
  ('ABBV',    'AbbVie Inc.',                           'Healthcare', 'Pharmaceuticals',       'US', 300),
  ('JNJ',     'Johnson & Johnson',                     'Healthcare', 'Pharmaceuticals',       'US', 301),
  ('LLY',     'Eli Lilly and Company',                 'Healthcare', 'Pharmaceuticals',       'US', 302),
  ('PFE',     'Pfizer Inc.',                           'Healthcare', 'Pharmaceuticals',       'US', 303),
  ('TMO',     'Thermo Fisher Scientific Inc.',         'Healthcare', 'Life Sciences Tools',   'US', 304),
  ('UNH',     'UnitedHealth Group Incorporated',       'Healthcare', 'Managed Care',          'US', 305),

  -- Consumer Staples
  ('COST',    'Costco Wholesale Corporation',          'Consumer Staples', 'Discount Stores', 'US', 400),
  ('KO',      'Coca-Cola Company',                     'Consumer Staples', 'Beverages',       'US', 401),
  ('PEP',     'PepsiCo, Inc.',                         'Consumer Staples', 'Beverages',       'US', 402),
  ('PG',      'Procter & Gamble Company',              'Consumer Staples', 'Household Goods', 'US', 403),
  ('WMT',     'Walmart Inc.',                          'Consumer Staples', 'Discount Stores', 'US', 404),

  -- Consumer Discretionary
  ('DIS',     'Walt Disney Company',                   'Consumer Discretionary', 'Entertainment',      'US', 500),
  ('HD',      'Home Depot Inc.',                       'Consumer Discretionary', 'Home Improvement',   'US', 501),
  ('MCD',     'McDonald''s Corporation',               'Consumer Discretionary', 'Restaurants',        'US', 502),
  ('NKE',     'NIKE, Inc.',                            'Consumer Discretionary', 'Apparel',            'US', 503),
  ('SBUX',    'Starbucks Corporation',                 'Consumer Discretionary', 'Restaurants',        'US', 504),

  -- Energy
  ('CNQ.TO',  'Canadian Natural Resources Limited',    'Energy', 'Oil & Gas Exploration', 'CA', 600),
  ('CVX',     'Chevron Corporation',                   'Energy', 'Oil & Gas Integrated',  'US', 601),
  ('ENB.TO',  'Enbridge Inc.',                         'Energy', 'Pipelines',             'CA', 602),
  ('SU.TO',   'Suncor Energy Inc.',                    'Energy', 'Oil & Gas Integrated',  'CA', 603),
  ('XOM',     'Exxon Mobil Corporation',               'Energy', 'Oil & Gas Integrated',  'US', 604),

  -- Industrials
  ('BA',      'Boeing Company',                        'Industrials', 'Aerospace & Defense', 'US', 700),
  ('CAT',     'Caterpillar Inc.',                      'Industrials', 'Construction Machinery', 'US', 701),
  ('CNR.TO',  'Canadian National Railway Company',     'Industrials', 'Railroads',           'CA', 702),
  ('CP.TO',   'Canadian Pacific Kansas City Limited',  'Industrials', 'Railroads',           'CA', 703),
  ('HON',     'Honeywell International Inc.',          'Industrials', 'Conglomerates',       'US', 704),
  ('RTX',     'RTX Corporation',                       'Industrials', 'Aerospace & Defense', 'US', 705),

  -- Communications
  ('BCE.TO',  'BCE Inc.',                              'Communications', 'Telecom',          'CA', 800),
  ('NFLX',    'Netflix, Inc.',                         'Communications', 'Entertainment',    'US', 801),
  ('T',       'AT&T Inc.',                             'Communications', 'Telecom',          'US', 802),
  ('T.TO',    'Telus Corporation',                     'Communications', 'Telecom',          'CA', 803),
  ('VZ',      'Verizon Communications Inc.',           'Communications', 'Telecom',          'US', 804),

  -- Utilities
  ('NEE',     'NextEra Energy, Inc.',                  'Utilities', 'Electric Utilities',    'US', 900);
