# ── Parse flags ─────────────────────────────────────────────────
BASELINE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --baseline) BASELINE="--baseline"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done