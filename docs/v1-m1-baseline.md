# M1 baseline

The selector is `lib/formula-svg.js` as carried from the M0 spike. It was not changed. Ground truth for this table is the pre-label set, not a finished human review. When `labels/reviewed/` has a page, that file is not substituted here yet; re-run after review if you want the reviewed numbers.

A1 counts left-hand outline ink with no SVG ink within r = 1, over the whole pre-label unit crop. The reference render is pdf.js with font faces off, the same paint the recorder saw. A2 counts a selected element whose label is not `formula`. A3 is exact element-set equality against pre-label units, plus mean Jaccard. A4 is the share of text-layer formula blocks whose SVG is empty. Prelabel fallback is the share of units whose confidence is below 0.65; that is the review queue, not the selector.

Identity conflicts are paints that matched two labels at once and were not given a character.

| paper | field | source | pages | units | A1 miss/solid | A2 neighbours | identity conflicts | A3 exact | A3 Jaccard | A4 empty SVG | prelabel fallback | record ms/page | build ms/page | SVG kB/page |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1706.03762 | ai | author-latex-preprint | 15 | 135 | 7165/2654 | 69 | 4 | 0.059 | 0.205 | 0.000 | 0.067 | 82.845 | 44.623 | 41.499 |
| 2006.11239 | ai | author-latex-preprint | 25 | 234 | 31690/12784 | 750 | 78 | 0.026 | 0.269 | 0.000 | 0.034 | 140.694 | 242.163 | 117.681 |
| 1412.6980 | ai | author-latex-preprint | 15 | 262 | 30623/11688 | 878 | 87 | 0.053 | 0.300 | 0.025 | 0.137 | 44.662 | 443.638 | 291.032 |
| s41467-018-07210-0 | ai | publisher-typeset | 10 | 190 | 10512/3804 | 366 | 186 | 0.011 | 0.150 | 0.000 | 0.568 | 138.583 | 808.413 | 66.938 |
| jmlr-21-19-1015 | ai | author-latex-journal | 63 | 1647 | 93145/36709 | 2559 | 154 | 0.101 | 0.296 | 0.070 | 0.163 | 43.155 | 268.229 | 233.761 |
| fms-2015-24 | math | author-latex-journal | 53 | 972 | 42455/17779 | 2616 | 66 | 0.101 | 0.344 | 0.000 | 0.229 | 30.524 | 179.896 | 154.713 |
| fms-2021-7 | math | author-latex-journal | 40 | 1187 | 143024/50822 | 2454 | 171 | 0.192 | 0.536 | 0.000 | 0.024 | 40.394 | 1607.072 | 415.973 |
| fms-2020-28 | math | author-latex-journal | 37 | 1358 | 63922/26546 | 3206 | 177 | 0.066 | 0.237 | 0.001 | 0.167 | 31.745 | 453.546 | 189.034 |
| crmath-64 | math | author-latex-journal | 8 | 251 | 17723/6941 | 1016 | 11 | 0.016 | 0.198 | 0.000 | 0.506 | 64.475 | 990.549 | 205.242 |
| 2004.05463 | math | author-latex-preprint | 20 | 519 | 32177/10934 | 1105 | 18 | 0.150 | 0.405 | 0.007 | 0.067 | 25.838 | 262.860 | 376.060 |
| hep-th-9711200 | physics | author-latex-preprint | 22 | 475 | 25155/10648 | 355 | 8 | 0.162 | 0.324 | 0.000 | 0.097 | 32.568 | 123.496 | 124.280 |
| 0901.2686 | physics | author-latex-preprint | 9 | 339 | 7197/1537 | 758 | 24 | 0.021 | 0.157 | 0.000 | 0.469 | 17.335 | 235.529 | 146.443 |
| hep-th-0603001 | physics | author-latex-preprint | 5 | 258 | 13843/2488 | 316 | 8 | 0.171 | 0.346 | 0.000 | 0.097 | 83.314 | 2041.398 | 485.446 |
| 1712.03344 | physics | author-latex-preprint | 17 | 526 | 38305/7008 | 857 | 73 | 0.122 | 0.292 | 0.002 | 0.078 | 70.571 | 811.358 | 420.598 |
| jhep04-2021-102 | physics | author-latex-journal | 102 | 3163 | 97633/36582 | 3969 | 301 | 0.127 | 0.296 | 0.105 | 0.179 | 49.547 | 336.099 | 223.657 |
| pcbi-1009231 | qbio | publisher-typeset | 25 | 315 | 10650/3398 | 535 | 54 | 0.010 | 0.152 | 0.000 | 0.257 | 91.380 | 117.905 | 61.383 |
| pcbi-1005421 | qbio | publisher-typeset | 16 | 137 | 4261/1485 | 105 | 3 | 0.022 | 0.111 | 0.000 | 0.380 | 85.385 | 41.062 | 35.848 |
| pcbi-1007670 | qbio | publisher-typeset | 17 | 159 | 7837/2616 | 143 | 14 | 0.006 | 0.134 | 0.000 | 0.321 | 76.509 | 58.602 | 29.704 |
| pcbi-1008462 | qbio | publisher-typeset | 29 | 453 | 17443/5807 | 665 | 72 | 0.068 | 0.163 | 0.000 | 0.514 | 83.966 | 157.561 | 75.322 |
| pcbi-1004584 | qbio | publisher-typeset | 38 | 249 | 15302/4050 | 99 | 3 | 0.000 | 0.059 | 0.000 | 0.526 | 68.624 | 16.332 | 6.200 |
| 1704.00447 | med | author-latex-preprint | 29 | 325 | 28512/11590 | 659 | 49 | 0.120 | 0.306 | 0.053 | 0.071 | 72.536 | 137.760 | 149.724 |
| 1707.06474 | med | author-latex-preprint | 11 | 193 | 11474/4564 | 441 | 3 | 0.098 | 0.322 | 0.000 | 0.057 | 316.557 | 678.363 | 173.229 |
| 1906.08754 | med | author-latex-preprint | 14 | 313 | 25312/9065 | 625 | 89 | 0.035 | 0.219 | 0.152 | 0.048 | 120.143 | 1074.412 | 216.455 |
| 1811.08839 | med | author-latex-preprint | 35 | 241 | 18328/8472 | 271 | 44 | 0.166 | 0.274 | 0.089 | 0.178 | 38.795 | 38.354 | 66.582 |
| 2002.05702 | med | author-latex-preprint | 19 | 95 | 6606/2614 | 192 | 3 | 0.084 | 0.270 | 0.000 | 0.063 | 118.890 | 62.870 | 42.854 |
| qe533 | econ | author-latex-journal | 31 | 518 | 40382/15498 | 1267 | 26 | 0.114 | 0.375 | 0.000 | 0.087 | 30.719 | 240.665 | 117.022 |
| 1410.3394 | econ | author-latex-preprint | 41 | 546 | 23145/9063 | 701 | 21 | 0.128 | 0.320 | 0.000 | 0.073 | 33.726 | 57.076 | 157.671 |
| 1802.03042 | econ | author-latex-preprint | 32 | 824 | 63697/22857 | 1296 | 60 | 0.124 | 0.330 | 0.002 | 0.025 | 53.270 | 374.616 | 282.702 |
| 1601.00991 | econ | author-latex-preprint | 22 | 123 | 11479/5169 | 293 | 2 | 0.179 | 0.358 | 0.000 | 0.008 | 49.795 | 35.278 | 61.638 |
| 1809.02233 | econ | author-latex-preprint | 14 | 82 | 2124/670 | 126 | 18 | 0.085 | 0.298 | 0.000 | 0.134 | 58.601 | 43.969 | 47.606 |

## By field

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | A4 empty | prelabel fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ai | 128 | 2468 | 173135/67639 | 4622 | 509 | 0.079 | 0.277 | 0.048 | 0.174 |
| math | 158 | 4287 | 299301/113022 | 10397 | 443 | 0.116 | 0.362 | 0.001 | 0.150 |
| physics | 155 | 4761 | 182133/58263 | 6255 | 414 | 0.125 | 0.291 | 0.066 | 0.176 |
| qbio | 125 | 1313 | 55493/17356 | 1547 | 146 | 0.029 | 0.132 | 0.000 | 0.417 |
| med | 108 | 1167 | 90232/36305 | 2188 | 188 | 0.100 | 0.276 | 0.073 | 0.084 |
| econ | 140 | 2093 | 140827/53257 | 3683 | 127 | 0.124 | 0.339 | 0.001 | 0.056 |

## By source type

| group | pages | units | A1 miss/solid | A2 | identity conflicts | A3 exact | A3 Jaccard | A4 empty | prelabel fallback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| author-latex-preprint | 345 | 5490 | 376832/133805 | 9692 | 589 | 0.112 | 0.304 | 0.019 | 0.097 |
| publisher-typeset | 135 | 1503 | 66005/21160 | 1913 | 332 | 0.027 | 0.134 | 0.000 | 0.436 |
| author-latex-journal | 334 | 9096 | 498284/190877 | 17087 | 906 | 0.115 | 0.325 | 0.039 | 0.163 |

