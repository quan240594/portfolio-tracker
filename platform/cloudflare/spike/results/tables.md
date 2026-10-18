### Heavy dataset

| Endpoint | Rows read (day / packed) | Stmts | Node CPU ms median / p95 (day layout) | Node CPU ms median / p95 (packed + D1 decode) | Cold call (packed) | Est. Worker ms = 2 x p95 (packed) | Verdict | Cold verdict |
|---|---|---|---|---|---|---|---|---|
| portfolio | 2,850 / 1,570 | 7 | 4.0 / 15 | 4.8 / 23 | 29 | 47 | RED | RED |
| holdings | 2,850 / 1,570 | 7 | 4.5 / 33 | 4.3 / 11 | 35 | 22 | RED | RED |
| allocation (assetClass) | 2,850 / 1,570 | 7 | 4.3 / 14 | 4.9 / 21 | 35 | 41 | RED | RED |
| allocation (category) | 2,091 / 811 | 10 | 4.8 / 13 | 3.1 / 14 | 21 | 27 | RED | RED |
| history (1Y) | 10,997 / 1,540 | 6 | 14 / 36 | 7.5 / 26 | 36 | 52 | RED | RED |
| history (ALL) | 42,211 / 1,660 | 6 | 80 / 140 | 30 / 55 | 87 | 110 | RED | RED |
| dividends | 3,379 / 2,099 | 4 | 4.2 / 19 | 5.2 / 26 | 27 | 52 | RED | RED |
| analytics/summary | 42,860 / 2,309 | 7 | 88 / 117 | 28 / 49 | 84 | 97 | RED | RED |
| analytics/returns (year) | 42,207 / 1,656 | 4 | 79 / 86 | 25 / 35 | 70 | 70 | RED | RED |
| analytics/returns (month) | 42,207 / 1,656 | 4 | 74 / 116 | 26 / 33 | 86 | 67 | RED | RED |
| analytics/risk | 42,207 / 1,656 | 4 | 74 / 99 | 25 / 60 | 86 | 119 | RED | RED |
| analytics/benchmark (ALL) | 42,207 / 1,656 | 4 | 78 / 106 | 25 / 35 | 76 | 71 | RED | RED |
| analytics/dividend-growth | 2,786 / 1,506 | 3 | 3.2 / 9.8 | 3.6 / 4.7 | 21 | 9.3 | RED | RED |
| analytics/goal | 3,439 / 2,159 | 6 | 4.8 / 14 | 6.3 / 17 | 32 | 33 | RED | RED |
| analytics/growth (1Y) | 42,408 / 1,696 | 7 | 90 / 106 | 30 / 39 | 97 | 78 | RED | RED |
| analytics/growth (ALL, 3 bench) | 42,408 / 1,696 | 7 | 133 / 214 | 37 / 61 | 116 | 123 | RED | RED |
| analytics/holdings-performance (ALL) | 42,267 / 1,716 | 6 | 208 / 317 | 138 / 207 | 237 | 414 | RED | RED |
| analytics/metrics | 42,268 / 1,717 | 7 | 83 / 112 | 28 / 36 | 83 | 71 | RED | RED |
| dividends/overview | 3,439 / 2,159 | 6 | 11 / 23 | 11 / 25 | 38 | 50 | RED | RED |
| calendar | 3,464 / 2,184 | 9 | 108 / 143 | 108 / 182 | 189 | 363 | RED | RED |
| calendar.ics | 3,464 / 2,184 | 9 | 117 / 177 | 119 / 187 | 169 | 374 | RED | RED |
| goals (GET) | 3,440 / 2,160 | 7 | 5.8 / 21 | 9.9 / 22 | 38 | 44 | RED | RED |
| goals/calculate (POST) | 3,439 / 2,159 | 6 | 6.0 / 20 | 9.3 / 21 | 49 | 43 | RED | RED |
| assets/AAPL | 37 / 28 | 5 | 0.2 / 1.4 | 0.5 / 2.7 | 15 | 5.4 | AMBER | RED |
| assets/AAPL/history (ALL) | 6,443 / 1,558 | 9 | 6.9 / 16 | 6.9 / 18 | 28 | 36 | RED | RED |
| assets/AAPL/positions | 4,735 / 2,215 | 14 | 4.9 / 13 | 6.0 / 20 | 24 | 40 | RED | RED |
| securities/closed | 2,816 / 1,536 | 4 | 4.0 / 11 | 3.8 / 9.9 | 22 | 20 | RED | RED |
| rebalance (buy-only) | 2,092 / 812 | 11 | 3.0 / 11 | 3.3 / 7.0 | 22 | 14 | RED | RED |
| rebalance (full) | 2,092 / 812 | 11 | 2.8 / 7.5 | 3.9 / 7.8 | 24 | 16 | RED | RED |
| export/transactions (csv) | 1,500 / 1,500 | 1 | 2.2 / 8.1 | 3.2 / 3.9 | 21 | 7.7 | AMBER | RED |
| export/backup (json) | 1,536 / 1,536 | 7 | 2.0 / 4.3 | 3.1 / 7.6 | 16 | 15 | RED | RED |
| health | 0 / 0 | 0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.4 | 0.0 | GREEN | GREEN |
| portfolios (list) | 3 / 3 | 1 | 0.0 / 0.1 | 0.0 / 0.1 | 3.6 | 0.2 | GREEN | AMBER |
| transactions (list, all) | 1,500 / 1,500 | 1 | 2.0 / 2.7 | 3.0 / 6.3 | 18 | 13 | RED | RED |
| transactions (list, one pf) | 747 / 747 | 2 | 1.0 / 4.7 | 1.5 / 5.7 | 13 | 11 | RED | RED |
| categories (list) | 25 / 25 | 3 | 0.1 / 0.9 | 0.0 / 0.2 | 2.4 | 0.3 | GREEN | AMBER |
| assets (list) | 5 / 5 | 3 | 0.0 / 1.1 | 0.0 / 0.3 | 5.5 | 0.5 | GREEN | RED |
| watchlist | 15 / 15 | 3 | 0.0 / 0.2 | 0.0 / 0.4 | 6.7 | 0.8 | GREEN | RED |
| settings (GET) | 2 / 2 | 2 | 0.0 / 0.3 | 0.0 / 0.2 | 2.1 | 0.5 | GREEN | AMBER |

### Baseline demo-size dataset

| Endpoint | Rows read (day / packed) | Stmts | Node CPU ms median / p95 (day layout) | Node CPU ms median / p95 (packed + D1 decode) | Cold call (packed) | Est. Worker ms = 2 x p95 (packed) | Verdict | Cold verdict |
|---|---|---|---|---|---|---|---|---|
| portfolio | 421 / 38 | 7 | 0.5 / 2.4 | 0.2 / 3.1 | 7.2 | 6.3 | AMBER | RED |
| holdings | 421 / 38 | 7 | 0.5 / 3.0 | 0.5 / 2.7 | 5.6 | 5.3 | AMBER | RED |
| allocation (assetClass) | 421 / 38 | 7 | 0.4 / 2.6 | 0.3 / 2.6 | 5.6 | 5.2 | AMBER | RED |
| allocation (category) | 39 / 39 | 9 | 0.1 / 0.4 | 0.1 / 0.6 | 6.0 | 1.1 | GREEN | RED |
| history (1Y) | 2,143 / 32 | 6 | 3.0 / 5.3 | 1.4 / 7.0 | 12 | 14 | RED | RED |
| history (ALL) | 2,924 / 32 | 6 | 4.2 / 9.2 | 2.8 / 8.6 | 15 | 17 | RED | RED |
| dividends | 410 / 27 | 4 | 0.3 / 2.2 | 0.1 / 1.6 | 5.4 | 3.3 | AMBER | RED |
| analytics/summary | 2,937 / 45 | 7 | 3.7 / 7.8 | 1.9 / 6.2 | 11 | 12 | RED | RED |
| analytics/returns (year) | 2,921 / 29 | 4 | 3.7 / 6.7 | 1.4 / 6.6 | 12 | 13 | RED | RED |
| analytics/returns (month) | 2,921 / 29 | 4 | 3.4 / 9.3 | 1.6 / 7.1 | 11 | 14 | RED | RED |
| analytics/risk | 2,921 / 29 | 4 | 3.9 / 9.8 | 2.4 / 8.4 | 13 | 17 | RED | RED |
| analytics/benchmark (ALL) | 2,921 / 29 | 4 | 4.2 / 8.4 | 1.7 / 4.9 | 14 | 9.9 | RED | RED |
| analytics/dividend-growth | 406 / 23 | 3 | 0.4 / 2.4 | 0.2 / 2.8 | 6.3 | 5.5 | AMBER | RED |
| analytics/goal | 422 / 39 | 6 | 1.0 / 3.4 | 0.5 / 2.9 | 8.3 | 5.9 | AMBER | RED |
| analytics/growth (1Y) | 3,044 / 41 | 7 | 5.1 / 9.9 | 2.9 / 11 | 18 | 22 | RED | RED |
| analytics/growth (ALL, 3 bench) | 3,044 / 41 | 7 | 6.3 / 12 | 3.8 / 11 | 19 | 22 | RED | RED |
| analytics/holdings-performance (ALL) | 2,933 / 41 | 6 | 7.5 / 11 | 4.5 / 9.4 | 28 | 19 | RED | RED |
| analytics/metrics | 2,934 / 42 | 7 | 4.8 / 6.7 | 2.6 / 6.0 | 17 | 12 | RED | RED |
| dividends/overview | 422 / 39 | 6 | 0.5 / 2.9 | 0.4 / 2.2 | 6.2 | 4.4 | AMBER | RED |
| calendar | 433 / 50 | 9 | 0.7 / 4.3 | 0.7 / 2.5 | 7.3 | 5.0 | AMBER | RED |
| calendar.ics | 433 / 50 | 9 | 2.3 / 4.6 | 1.3 / 4.9 | 9.5 | 9.7 | RED | RED |
| goals (GET) | 422 / 39 | 7 | 1.0 / 2.8 | 0.9 / 2.8 | 9.3 | 5.7 | AMBER | RED |
| goals/calculate (POST) | 422 / 39 | 6 | 1.2 / 5.1 | 1.1 / 3.2 | 8.1 | 6.4 | AMBER | RED |
| assets/AAPL | 14 / 4 | 5 | 0.0 / 0.3 | 0.0 / 0.7 | 4.0 | 1.5 | GREEN | RED |
| assets/AAPL/history (ALL) | 1,492 / 39 | 9 | 2.5 / 5.8 | 0.4 / 2.4 | 5.6 | 4.8 | AMBER | RED |
| assets/AAPL/positions | 802 / 40 | 14 | 0.7 / 2.6 | 0.3 / 1.9 | 5.8 | 3.8 | AMBER | RED |
| securities/closed | 412 / 29 | 4 | 0.3 / 1.7 | 0.2 / 1.6 | 3.3 | 3.1 | AMBER | AMBER |
| rebalance (buy-only) | 40 / 40 | 10 | 0.1 / 0.9 | 0.1 / 0.6 | 6.9 | 1.2 | GREEN | RED |
| rebalance (full) | 40 / 40 | 10 | 0.1 / 1.0 | 0.2 / 2.2 | 6.9 | 4.3 | AMBER | RED |
| export/transactions (csv) | 21 / 21 | 1 | 0.0 / 0.6 | 0.0 / 0.5 | 3.4 | 1.0 | GREEN | AMBER |
| export/backup (json) | 39 / 39 | 7 | 0.1 / 0.6 | 0.1 / 0.4 | 2.8 | 0.9 | GREEN | AMBER |
| health | 0 / 0 | 0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.6 | 0.0 | GREEN | GREEN |
| portfolios (list) | 2 / 2 | 1 | 0.0 / 0.2 | 0.0 / 0.0 | 1.0 | 0.0 | GREEN | GREEN |
| transactions (list, all) | 21 / 21 | 1 | 0.0 / 0.5 | 0.0 / 0.5 | 4.2 | 1.0 | GREEN | RED |
| transactions (list, one pf) | 17 / 17 | 2 | 0.0 / 0.5 | 0.0 / 0.6 | 3.0 | 1.2 | GREEN | AMBER |
| categories (list) | 11 / 11 | 3 | 0.0 / 0.3 | 0.0 / 0.4 | 3.6 | 0.9 | GREEN | AMBER |
| assets (list) | 4 / 4 | 3 | 0.0 / 0.8 | 0.0 / 0.2 | 4.7 | 0.4 | GREEN | RED |
| watchlist | 9 / 9 | 3 | 0.0 / 0.7 | 0.0 / 0.4 | 3.2 | 0.7 | GREEN | AMBER |
| settings (GET) | 2 / 2 | 2 | 0.0 / 0.4 | 0.0 / 0.0 | 3.8 | 0.0 | GREEN | AMBER |

Verdict counts (warm, 2 x p95): {"heavy/day-plain":{"GREEN":7,"AMBER":1,"RED":31},"heavy/packed-d1":{"GREEN":6,"AMBER":2,"RED":31},"baseline/day-plain":{"GREEN":14,"AMBER":10,"RED":15},"baseline/packed-d1":{"GREEN":13,"AMBER":14,"RED":12}}
