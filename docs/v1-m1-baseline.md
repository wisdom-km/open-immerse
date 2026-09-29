# M1 baseline

The selector is `lib/formula-svg.js` as carried from the M0 spike. It was not changed. These numbers are measured against the unreviewed pre-labels in `labels/prelabel/`. Reviewed JSON under `labels/reviewed/` is not substituted.

A1 counts left-hand outline ink with no SVG ink within r = 1, over the whole pre-label unit crop. The reference render is pdf.js with font faces off, the same paint the recorder saw. A2 counts a selected element whose label is not `formula`. A3 is exact element-set equality against pre-label units, plus mean Jaccard. Empty SVG is the share of text-layer formula blocks whose SVG is empty. A4 fallback is the share of pre-label formula units whose self-reported confidence is below 0.65. It is not an accuracy rate. Those are different columns.

Identity conflicts are paints that matched two labels at once and were not given a character.

Record and build timings are printed by the script and are not stored in this file.

| paper | field | source | pages | units | A1 miss/solid | A2 neighbours | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback | SVG kB/page |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1706.03762 | ai | author-latex-preprint | 15 | 135 | 6945/2430 | 38 | 4 | 0.119 | 0.217 | 0.000 | 0.422 | 41.499 |
| 2006.11239 | ai | author-latex-preprint | 25 | 396 | 14477/6019 | 232 | 78 | 0.126 | 0.311 | 0.000 | 0.525 | 117.681 |
| s41467-018-07210-0 | ai | publisher-typeset | 10 | 228 | 8595/2543 | 198 | 186 | 0.044 | 0.188 | 0.000 | 0.759 | 66.938 |
| s41467-019-09785-8 | ai | publisher-typeset | 11 | 332 | 9061/1896 | 459 | 431 | 0.015 | 0.134 | 0.000 | 0.837 | 164.321 |
| s41467-021-26434-1 | ai | publisher-typeset | 13 | 328 | 13515/4079 | 349 | 11 | 0.067 | 0.190 | 0.000 | 0.628 | 90.434 |
| crmath-64 | math | author-latex-journal | 8 | 344 | 12682/4841 | 552 | 11 | 0.067 | 0.237 | 0.000 | 0.712 | 205.242 |
| fms-2021-7 | math | author-latex-journal | 40 | 2040 | 73594/23959 | 1064 | 171 | 0.259 | 0.508 | 0.000 | 0.408 | 415.973 |
| s41598-017-00844-y | math | publisher-typeset | 11 | 221 | 7322/1835 | 533 | 146 | 0.023 | 0.309 | 0.000 | 0.801 | 239.863 |
| s41598-022-19656-w | math | publisher-typeset | 16 | 362 | 15080/5819 | 771 | 18 | 0.039 | 0.188 | 0.000 | 0.685 | 144.638 |
| s41598-023-28973-7 | math | publisher-typeset | 11 | 157 | 2736/1076 | 313 | 5 | 0.013 | 0.192 | 0.000 | 0.459 | 108.559 |
| jhep04-2021-102 | physics | author-latex-journal | 102 | 3913 | 52498/22794 | 1800 | 301 | 0.193 | 0.318 | 0.105 | 0.458 | 223.657 |
| s41467-019-10988-2 | physics | publisher-typeset | 9 | 165 | 5810/1834 | 110 | 161 | 0.012 | 0.088 | 0.000 | 0.861 | 47.204 |
| s41467-020-19530-1 | physics | publisher-typeset | 7 | 198 | 7575/2285 | 97 | 22 | 0.035 | 0.162 | 0.000 | 0.742 | 67.380 |
| s41467-026-69035-6 | physics | publisher-typeset | 6 | 163 | 4884/1803 | 368 | 49 | 0.031 | 0.177 | 0.000 | 0.761 | 142.522 |
| s42005-024-01697-4 | physics | publisher-typeset | 12 | 367 | 8573/2252 | 620 | 151 | 0.011 | 0.078 | 0.000 | 0.861 | 87.369 |
| pcbi-1004584 | qbio | publisher-typeset | 38 | 276 | 7404/2423 | 56 | 3 | 0.065 | 0.104 | 0.000 | 0.641 | 6.200 |
| pcbi-1005421 | qbio | publisher-typeset | 16 | 141 | 2438/771 | 62 | 3 | 0.035 | 0.138 | 0.000 | 0.482 | 35.848 |
| pcbi-1007670 | qbio | publisher-typeset | 17 | 177 | 4093/1314 | 81 | 14 | 0.034 | 0.156 | 0.000 | 0.599 | 29.704 |
| pcbi-1008462 | qbio | publisher-typeset | 29 | 523 | 14252/4467 | 428 | 72 | 0.078 | 0.176 | 0.000 | 0.639 | 75.322 |
| pcbi-1009231 | qbio | publisher-typeset | 25 | 335 | 5736/1930 | 263 | 54 | 0.072 | 0.229 | 0.000 | 0.669 | 61.383 |
| bmc-12874-022-01542-8 | med | publisher-typeset | 20 | 205 | 4174/1417 | 201 | 426 | 0.200 | 0.281 | 0.000 | 0.341 | 49.754 |
| s41598-020-70551-8 | med | publisher-typeset | 13 | 86 | 3359/1196 | 172 | 0 | 0.093 | 0.338 | 0.000 | 0.535 | 55.420 |
| s41598-021-85174-w | med | publisher-typeset | 17 | 192 | 10442/3374 | 165 | 1 | 0.005 | 0.128 | 0.000 | 0.828 | 64.524 |
| s41598-022-05108-y | med | publisher-typeset | 18 | 61 | 3166/1087 | 64 | 0 | 0.066 | 0.195 | 0.000 | 0.852 | 26.824 |
| s41598-023-31124-7 | med | publisher-typeset | 12 | 144 | 5272/1776 | 197 | 0 | 0.049 | 0.285 | 0.000 | 0.715 | 72.648 |
| 1410.3394 | econ | author-latex-preprint | 41 | 706 | 7766/3041 | 394 | 21 | 0.218 | 0.332 | 0.000 | 0.346 | 157.671 |
| pone-0125679 | econ | publisher-typeset | 35 | 775 | 27341/7010 | 626 | 114 | 0.041 | 0.097 | 0.000 | 0.925 | 56.054 |
| pone-0215032 | econ | publisher-typeset | 18 | 350 | 9937/3552 | 139 | 59 | 0.049 | 0.166 | 0.000 | 0.814 | 79.622 |
| qe533 | econ | author-latex-journal | 31 | 789 | 13024/5370 | 359 | 26 | 0.203 | 0.347 | 0.000 | 0.577 | 117.022 |
| s41598-024-77073-7 | econ | publisher-typeset | 13 | 184 | 3213/1072 | 194 | 32 | 0.136 | 0.316 | 0.000 | 0.620 | 230.255 |

## By field

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ai | 74 | 1419 | 52593/16967 | 1276 | 710 | 0.073 | 0.213 | 0.000 | 0.650 |
| math | 86 | 3124 | 111414/37530 | 3233 | 351 | 0.183 | 0.411 | 0.000 | 0.504 |
| physics | 136 | 4806 | 79340/30968 | 2995 | 684 | 0.161 | 0.280 | 0.091 | 0.524 |
| qbio | 125 | 1452 | 33923/10905 | 890 | 146 | 0.065 | 0.168 | 0.000 | 0.626 |
| med | 80 | 688 | 26413/8850 | 799 | 427 | 0.089 | 0.238 | 0.000 | 0.625 |
| econ | 138 | 2804 | 61281/20045 | 1712 | 252 | 0.138 | 0.249 | 0.000 | 0.647 |

## By source type

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | empty SVG | A4 fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| author-latex-preprint | 81 | 1237 | 29188/11490 | 664 | 103 | 0.178 | 0.313 | 0.000 | 0.411 |
| publisher-typeset | 377 | 5970 | 183978/56811 | 6466 | 1958 | 0.051 | 0.171 | 0.000 | 0.727 |
| author-latex-journal | 181 | 7086 | 151798/56964 | 3775 | 509 | 0.207 | 0.372 | 0.046 | 0.469 |

## Skipped

No papers were skipped.
