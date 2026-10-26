#!/usr/bin/env python3
"""Run the product-path leak scan. Rules live in lib/pdf-leak-rules.js.

Usage:
  python3 oi-qa/journal-pdf/tools/leak_scan.py --corpus /path/to/pdfs
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = Path(__file__).with_name("leak_scan.mjs")


def main() -> int:
    return subprocess.call(["node", str(SCRIPT), *sys.argv[1:]], cwd=ROOT)


if __name__ == "__main__":
    raise SystemExit(main())
