# M1 baseline

The selector is `lib/formula-svg.js` as carried from the M0 spike. It was not changed. These numbers are measured against the unreviewed pre-labels in `labels/prelabel/`. Reviewed JSON under `labels/reviewed/` is not substituted.

A1 counts left-hand outline ink with no SVG ink within r = 1, over the whole pre-label unit crop. The reference render is pdf.js with font faces off, the same paint the recorder saw. A2 counts a selected element whose label is not `formula`. A3 is exact element-set equality against pre-label units, plus mean Jaccard. Empty SVG is the share of text-layer formula blocks whose SVG is empty. A4 fallback is the share of pre-label formula units whose confidence is below 0.65. Those are different columns.

Identity conflicts are paints that matched two labels at once and were not given a character.

Record and build timings are printed by the script and are not stored in this file.

| paper | field | source | pages | units | A1 miss/solid | A2 neighbours | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback | SVG kB/page |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1706.03762 | ai | author-latex-preprint | 15 | 135 | 7165/2654 | 69 | 4 | 0.059 | 0.205 | 0.000 | 0.067 | 41.499 |
| 2006.11239 | ai | author-latex-preprint | 25 | 234 | 31690/12784 | 750 | 78 | 0.026 | 0.269 | 0.000 | 0.034 | 117.681 |
| s41467-018-07210-0 | ai | publisher-typeset | 10 | 190 | 10512/3804 | 366 | 186 | 0.011 | 0.150 | 0.000 | 0.568 | 66.938 |
| s41467-019-09785-8 | ai | publisher-typeset | 11 | 311 | 6897/1625 | 808 | 431 | 0.000 | 0.103 | 0.000 | 0.707 | 164.321 |
| s41467-021-26434-1 | ai | publisher-typeset | 13 | 323 | 9897/3065 | 519 | 11 | 0.037 | 0.173 | 0.000 | 0.365 | 90.434 |
| crmath-64 | math | author-latex-journal | 8 | 251 | 17723/6941 | 1016 | 11 | 0.016 | 0.198 | 0.000 | 0.506 | 205.242 |
| fms-2021-7 | math | author-latex-journal | 40 | 1187 | 143024/50822 | 2454 | 171 | 0.192 | 0.536 | 0.000 | 0.024 | 415.973 |
| s41598-017-00844-y | math | publisher-typeset | 11 | 194 | 14922/4519 | 1118 | 146 | 0.005 | 0.224 | 0.000 | 0.546 | 239.863 |
| s41598-022-19656-w | math | publisher-typeset | 16 | 284 | 18662/7061 | 1168 | 18 | 0.000 | 0.165 | 0.000 | 0.475 | 144.638 |
| s41598-023-28973-7 | math | publisher-typeset | 11 | 133 | 5935/1998 | 552 | 5 | 0.023 | 0.177 | 0.000 | 0.436 | 108.559 |
| jhep04-2021-102 | physics | author-latex-journal | 102 | 3163 | 97633/36582 | 3969 | 301 | 0.127 | 0.296 | 0.105 | 0.179 | 223.657 |
| s41467-019-10988-2 | physics | publisher-typeset | 9 | 147 | 4719/1605 | 221 | 161 | 0.000 | 0.052 | 0.000 | 0.687 | 47.204 |
| s41467-020-19530-1 | physics | publisher-typeset | 7 | 182 | 6219/2234 | 163 | 22 | 0.027 | 0.144 | 0.000 | 0.462 | 67.380 |
| s41467-026-69035-6 | physics | publisher-typeset | 6 | 181 | 7814/3943 | 565 | 49 | 0.022 | 0.141 | 0.000 | 0.586 | 142.522 |
| s42005-024-01697-4 | physics | publisher-typeset | 12 | 376 | 6911/2344 | 928 | 151 | 0.013 | 0.056 | 0.000 | 0.793 | 87.369 |
| pcbi-1004584 | qbio | publisher-typeset | 38 | 249 | 15302/4050 | 99 | 3 | 0.000 | 0.059 | 0.000 | 0.526 | 6.200 |
| pcbi-1005421 | qbio | publisher-typeset | 16 | 137 | 4261/1485 | 105 | 3 | 0.022 | 0.111 | 0.000 | 0.380 | 35.848 |
| pcbi-1007670 | qbio | publisher-typeset | 17 | 159 | 7837/2616 | 143 | 14 | 0.006 | 0.134 | 0.000 | 0.321 | 29.704 |
| pcbi-1008462 | qbio | publisher-typeset | 29 | 453 | 17443/5807 | 665 | 72 | 0.068 | 0.163 | 0.000 | 0.514 | 75.322 |
| pcbi-1009231 | qbio | publisher-typeset | 25 | 315 | 10650/3398 | 535 | 54 | 0.010 | 0.152 | 0.000 | 0.257 | 61.383 |
| bmc-12874-022-01542-8 | med | publisher-typeset | 20 | 198 | 11926/5086 | 255 | 426 | 0.177 | 0.238 | 0.000 | 0.217 | 49.754 |
| s41598-020-70551-8 | med | publisher-typeset | 13 | 121 | 6696/2398 | 219 | 0 | 0.025 | 0.140 | 0.000 | 0.603 | 55.420 |
| s41598-021-85174-w | med | publisher-typeset | 17 | 206 | 11554/3707 | 360 | 1 | 0.005 | 0.085 | 0.000 | 0.869 | 64.524 |
| s41598-022-05108-y | med | publisher-typeset | 18 | 153 | 4578/1657 | 103 | 0 | 0.000 | 0.043 | 0.000 | 0.954 | 26.824 |
| s41598-023-31124-7 | med | publisher-typeset | 12 | 137 | 5967/1959 | 336 | 0 | 0.000 | 0.221 | 0.000 | 0.445 | 72.648 |
| 1410.3394 | econ | author-latex-preprint | 41 | 546 | 23145/9063 | 701 | 21 | 0.128 | 0.320 | 0.000 | 0.073 | 157.671 |
| pone-0125679 | econ | publisher-typeset | 35 | 803 | 28133/7976 | 1004 | 114 | 0.010 | 0.044 | 0.000 | 0.853 | 56.054 |
| pone-0215032 | econ | publisher-typeset | 18 | 362 | 14974/4967 | 453 | 59 | 0.014 | 0.101 | 0.000 | 0.439 | 79.622 |
| qe533 | econ | author-latex-journal | 31 | 518 | 40382/15498 | 1267 | 26 | 0.114 | 0.375 | 0.000 | 0.087 | 117.022 |
| s41598-024-77073-7 | econ | publisher-typeset | 13 | 156 | 9770/2678 | 486 | 32 | 0.071 | 0.247 | 0.000 | 0.365 | 230.255 |

## By field

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ai | 74 | 1193 | 66161/23932 | 2512 | 710 | 0.023 | 0.173 | 0.000 | 0.388 |
| math | 86 | 2049 | 200266/71341 | 6308 | 351 | 0.115 | 0.390 | 0.000 | 0.222 |
| physics | 136 | 4049 | 123296/46708 | 5846 | 684 | 0.102 | 0.251 | 0.091 | 0.285 |
| qbio | 125 | 1313 | 55493/17356 | 1547 | 146 | 0.029 | 0.132 | 0.000 | 0.417 |
| med | 80 | 815 | 40721/14807 | 1273 | 427 | 0.048 | 0.145 | 0.000 | 0.616 |
| econ | 138 | 2385 | 116404/40182 | 3911 | 252 | 0.064 | 0.201 | 0.000 | 0.413 |

## By source type

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| author-latex-preprint | 81 | 915 | 62000/24501 | 1520 | 103 | 0.092 | 0.290 | 0.000 | 0.062 |
| publisher-typeset | 377 | 5770 | 241579/79982 | 11171 | 1958 | 0.023 | 0.123 | 0.000 | 0.569 |
| author-latex-journal | 181 | 5119 | 298762/109843 | 8706 | 509 | 0.135 | 0.355 | 0.046 | 0.150 |

## Skipped

No papers were skipped.
