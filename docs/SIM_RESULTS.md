# SLIME Digital-Twin Simulation Results

Deterministic sandbox runs (seeds: 20261012, 1, 42). No real network activity.

## Lineage learning curve: first-attempt success rate by generation

| generation | first-attempt success | agents | cumulative success rate |
|---:|---:|---:|---:|
| 0 | 100.0% | 3 | 74.6% |
| 1 | 65.1% | 43 | 79.5% |
| 2 | 75.4% | 175 | 80.7% |
| 3 | 77.4% | 447 | 80.9% |
| 4 | 75.9% | 477 | 80.8% |
| 5 | 83.1% | 231 | 81.8% |
| 6 | 62.1% | 29 | 79.4% |

Reference from the Anthropic post (6 generations of Qwen3.5-9B): 45% -> 61-84%.
Note: plateau at high generation counts and bursty birth pattern are the
three-layer caps throttling R0 (daily budget binds before fertility does).

## Epidemic trajectory (seed 20261012)

| epoch | births | alive | R0 | cumulative |
|---:|---:|---:|---:|---:|
| 1-4 | 4 | 2 | 0.50 | 5 |
| 5-8 | 8 | 4 | 0.50 | 13 |
| 9-12 | 36 | 12 | 0.75 | 49 |
| 13-16 | 36 | 47 | 0.19 | 85 |
| 17-20 | 60 | 73 | 0.21 | 145 |
| 21-24 | 5 | 108 | 0.01 | 150 |
| 25-28 | 0 | 133 | 0.00 | 150 |
| 29-32 | 65 | 138 | 0.12 | 215 |
| 33-36 | 0 | 193 | 0.00 | 215 |
| 37-40 | 65 | 192 | 0.08 | 280 |
| 41-44 | 0 | 228 | 0.00 | 280 |
| 45-48 | 0 | 247 | 0.00 | 280 |
| 49-52 | 65 | 251 | 0.06 | 345 |
| 53-56 | 0 | 306 | 0.00 | 345 |
| 57-60 | 65 | 304 | 0.05 | 410 |
| 61-64 | 0 | 342 | 0.00 | 410 |
| 65-68 | 0 | 363 | 0.00 | 410 |
| 69-72 | 65 | 371 | 0.04 | 475 |
| 73-76 | 0 | 426 | 0.00 | 475 |
| 77-80 | 65 | 425 | 0.04 | 540 |

Run 0: final alive=425 quarantined=0, total ever=540, max generation=6
Run 1: final alive=410 quarantined=0, total ever=543, max generation=6
Run 2: final alive=408 quarantined=0, total ever=515, max generation=6
