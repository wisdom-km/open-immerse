# M1 baseline

The selector is `lib/formula-svg.js` as carried from the M0 spike. It was not changed. These numbers are measured against the unreviewed pre-labels in `labels/prelabel/`. Reviewed JSON under `labels/reviewed/` is not substituted.

A1 counts left-hand outline ink with no SVG ink within r = 1, over the whole pre-label unit crop. The reference render is pdf.js with font faces off, the same paint the recorder saw. A2 counts a selected element whose label is not `formula`. A3 is exact element-set equality against pre-label units, plus mean Jaccard. Empty SVG is the share of text-layer formula blocks whose SVG is empty. A4 fallback is the share of pre-label formula units whose confidence is below 0.65. Those are different columns.

Identity conflicts are paints that matched two labels at once and were not given a character.

Record and build timings are printed by the script and are not stored in this file.

| paper | field | source | pages | units | A1 miss/solid | A2 neighbours | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback | SVG kB/page |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1706.03762 | ai | author-latex-preprint | 15 | 125 | 7752/2889 | 38 | 4 | 0.136 | 0.241 | 0.000 | 0.016 | 41.499 |
| 2006.11239 | ai | author-latex-preprint | 25 | 220 | 33354/13590 | 227 | 78 | 0.191 | 0.394 | 0.000 | 0.005 | 117.681 |
| s41467-018-07210-0 | ai | publisher-typeset | 10 | 176 | 18512/7065 | 193 | 186 | 0.034 | 0.194 | 0.000 | 0.068 | 66.938 |
| s41467-019-09785-8 | ai | publisher-typeset | 11 | 261 | 15594/4329 | 454 | 431 | 0.008 | 0.147 | 0.000 | 0.134 | 164.321 |
| s41467-021-26434-1 | ai | publisher-typeset | 13 | 287 | 19260/6054 | 349 | 11 | 0.070 | 0.207 | 0.000 | 0.122 | 90.434 |
| crmath-64 | math | author-latex-journal | 8 | 207 | 25097/10238 | 539 | 11 | 0.043 | 0.266 | 0.000 | 0.242 | 205.242 |
| fms-2021-7 | math | author-latex-journal | 40 | 1146 | 150273/53747 | 947 | 171 | 0.277 | 0.575 | 0.000 | 0.008 | 415.973 |
| s41598-017-00844-y | math | publisher-typeset | 11 | 146 | 17034/5131 | 468 | 146 | 0.027 | 0.362 | 0.000 | 0.130 | 239.863 |
| s41598-022-19656-w | math | publisher-typeset | 16 | 228 | 21716/8265 | 769 | 18 | 0.053 | 0.273 | 0.000 | 0.066 | 144.638 |
| s41598-023-28973-7 | math | publisher-typeset | 11 | 106 | 5583/1874 | 311 | 5 | 0.019 | 0.261 | 0.000 | 0.113 | 108.559 |
| jhep04-2021-102 | physics | author-latex-journal | 102 | 3017 | 107583/41932 | 1684 | 301 | 0.200 | 0.346 | 0.105 | 0.037 | 223.657 |
| s41467-019-10988-2 | physics | publisher-typeset | 9 | 137 | 11827/4419 | 106 | 161 | 0.007 | 0.061 | 0.000 | 0.219 | 47.204 |
| s41467-020-19530-1 | physics | publisher-typeset | 7 | 168 | 14562/5389 | 96 | 22 | 0.036 | 0.168 | 0.000 | 0.018 | 67.380 |
| s41467-026-69035-6 | physics | publisher-typeset | 6 | 138 | 5990/2237 | 360 | 49 | 0.022 | 0.186 | 0.000 | 0.130 | 142.522 |
| s42005-024-01697-4 | physics | publisher-typeset | 12 | 309 | 11459/3701 | 613 | 151 | 0.013 | 0.089 | 0.000 | 0.123 | 87.369 |
| pcbi-1004584 | qbio | publisher-typeset | 38 | 230 | 18294/5174 | 56 | 3 | 0.052 | 0.097 | 0.000 | 0.152 | 6.200 |
| pcbi-1005421 | qbio | publisher-typeset | 16 | 129 | 4774/1701 | 61 | 3 | 0.039 | 0.130 | 0.000 | 0.000 | 35.848 |
| pcbi-1007670 | qbio | publisher-typeset | 17 | 145 | 9432/3238 | 75 | 14 | 0.041 | 0.174 | 0.000 | 0.000 | 29.704 |
| pcbi-1008462 | qbio | publisher-typeset | 29 | 405 | 22589/7834 | 413 | 72 | 0.079 | 0.191 | 0.000 | 0.015 | 75.322 |
| pcbi-1009231 | qbio | publisher-typeset | 25 | 260 | 13826/4715 | 245 | 54 | 0.062 | 0.236 | 0.000 | 0.015 | 61.383 |
| bmc-12874-022-01542-8 | med | publisher-typeset | 20 | 193 | 12758/5253 | 199 | 426 | 0.192 | 0.261 | 0.000 | 0.010 | 49.754 |
| s41598-020-70551-8 | med | publisher-typeset | 13 | 70 | 6466/2319 | 167 | 0 | 0.057 | 0.306 | 0.000 | 0.100 | 55.420 |
| s41598-021-85174-w | med | publisher-typeset | 17 | 155 | 11766/3874 | 147 | 1 | 0.006 | 0.135 | 0.000 | 0.032 | 64.524 |
| s41598-022-05108-y | med | publisher-typeset | 18 | 44 | 3634/1227 | 64 | 0 | 0.023 | 0.177 | 0.000 | 0.136 | 26.824 |
| s41598-023-31124-7 | med | publisher-typeset | 12 | 113 | 7807/2746 | 188 | 0 | 0.044 | 0.302 | 0.000 | 0.097 | 72.648 |
| 1410.3394 | econ | author-latex-preprint | 41 | 501 | 23612/9341 | 387 | 21 | 0.222 | 0.387 | 0.000 | 0.012 | 157.671 |
| pone-0125679 | econ | publisher-typeset | 35 | 611 | 44467/13074 | 610 | 114 | 0.023 | 0.078 | 0.000 | 0.185 | 56.054 |
| pone-0215032 | econ | publisher-typeset | 18 | 247 | 23031/7821 | 115 | 59 | 0.040 | 0.173 | 0.000 | 0.089 | 79.622 |
| qe533 | econ | author-latex-journal | 31 | 459 | 45252/17987 | 278 | 26 | 0.240 | 0.466 | 0.000 | 0.002 | 117.022 |
| s41598-024-77073-7 | econ | publisher-typeset | 13 | 108 | 9341/2648 | 194 | 32 | 0.222 | 0.434 | 0.000 | 0.046 | 230.255 |

## By field

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ai | 74 | 1069 | 94472/33927 | 1261 | 710 | 0.081 | 0.233 | 0.000 | 0.080 |
| math | 86 | 1833 | 219703/79255 | 3034 | 351 | 0.188 | 0.467 | 0.000 | 0.057 |
| physics | 136 | 3769 | 151421/57678 | 2859 | 684 | 0.163 | 0.301 | 0.091 | 0.053 |
| qbio | 125 | 1169 | 68915/22662 | 850 | 146 | 0.061 | 0.174 | 0.000 | 0.038 |
| med | 80 | 575 | 42431/15419 | 765 | 427 | 0.083 | 0.234 | 0.000 | 0.054 |
| econ | 138 | 1926 | 145703/50871 | 1584 | 252 | 0.140 | 0.283 | 0.000 | 0.076 |

## By source type

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| author-latex-preprint | 81 | 846 | 64718/25820 | 652 | 103 | 0.201 | 0.368 | 0.000 | 0.011 |
| publisher-typeset | 377 | 4666 | 329722/110088 | 6253 | 1958 | 0.049 | 0.180 | 0.000 | 0.093 |
| author-latex-journal | 181 | 4829 | 328205/123904 | 3448 | 509 | 0.215 | 0.409 | 0.046 | 0.036 |

## Skipped

No papers were skipped.
