#!/bin/bash
# =============================================================================
# Transcribe audio files using Whisper
# Processes all audio files in transcripts/ that don't have a matching .txt
# Usage: bash scripts/transcribe.sh <project-name>
# =============================================================================

PROJECT="$1"
if [ -z "$PROJECT" ]; then
  echo "Usage: bash scripts/transcribe.sh <project-name>"
  exit 1
fi

# Force UTF-8 I/O so Whisper's output never crashes on a non-Latin character
# under the Windows cp1252 console.
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../projects/$PROJECT/config.json"
TRANSCRIPTS_DIR="$SCRIPT_DIR/../projects/$PROJECT/transcripts"

if [ ! -d "$TRANSCRIPTS_DIR" ]; then
  echo "No transcripts directory found for project: $PROJECT"
  exit 1
fi

# Find a usable Python command (Windows-friendly: python, py, python3,
# then fall back to scanning the standard per-user install dir).
if command -v python >/dev/null 2>&1; then
  PYTHON="python"
elif command -v py >/dev/null 2>&1; then
  PYTHON="py"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON="python3"
else
  PYTHON=""
  for EXE in "$LOCALAPPDATA"/Programs/Python/Python3*/python.exe; do
    if [ -f "$EXE" ]; then PYTHON="$EXE"; break; fi
  done
  if [ -z "$PYTHON" ]; then
    echo "Python not found on PATH. Install Python 3 and try again."
    exit 1
  fi
fi

# Read whisperLanguage from config.json (defaults to "auto" if missing)
WHISPER_LANG="auto"
if [ -f "$CONFIG_FILE" ]; then
  WHISPER_LANG=$("$PYTHON" -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('whisperLanguage','auto'))" 2>/dev/null || echo "auto")
fi

# Read whisperModel from config.json (defaults to "small" — tiny is too weak for
# Darija; small is the smallest model that produces usable Arabic/Darija text).
# Override per project by adding "whisperModel": "tiny|base|small|medium" to config.
WHISPER_MODEL="small"
if [ -f "$CONFIG_FILE" ]; then
  WHISPER_MODEL=$("$PYTHON" -c "import json; c=json.load(open('$CONFIG_FILE')); print(c.get('whisperModel','small'))" 2>/dev/null || echo "small")
fi

# Null-delimited collection so paths with spaces (e.g. "instagram research")
# are handled correctly. The array keeps the loop in the main shell so the
# counters below survive.
mapfile -t -d '' AUDIO_FILES < <(
  find "$TRANSCRIPTS_DIR" \( -name "*.mp3" -o -name "*.m4a" -o -name "*.webm" -o -name "*.opus" \) -print0 | sort -z
)
TOTAL=${#AUDIO_FILES[@]}

if [ "$TOTAL" -eq 0 ]; then
  echo "No audio files to transcribe."
  exit 0
fi

echo ""
echo "========================================"
echo "  Transcribing $TOTAL audio files"
echo "  Project: $PROJECT"
echo "  Model:   $WHISPER_MODEL"
echo "  Lang:    $WHISPER_LANG"
echo "========================================"
echo ""

DONE=0
SKIPPED=0

for AUDIO in "${AUDIO_FILES[@]}"; do
  FILENAME=$(basename "$AUDIO")
  BASENAME="${FILENAME%.*}"
  TXT_FILE="$TRANSCRIPTS_DIR/$BASENAME.txt"

  if [ -f "$TXT_FILE" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  DONE=$((DONE + 1))
  echo "  [$DONE/$TOTAL] $BASENAME..."

  # Build language flag: if "auto" or empty, omit --language so Whisper auto-detects
  LANG_FLAG=""
  if [ -n "$WHISPER_LANG" ] && [ "$WHISPER_LANG" != "auto" ]; then
    LANG_FLAG="--language $WHISPER_LANG"
  fi

  "$PYTHON" -m whisper "$AUDIO" \
    --model "$WHISPER_MODEL" \
    $LANG_FLAG \
    --output_format txt \
    --output_dir "$TRANSCRIPTS_DIR" \
    --fp16 False \
    --verbose False \
    2>/dev/null

  if [ -f "$TXT_FILE" ]; then
    echo "    ok ($(wc -w < "$TXT_FILE" | tr -d ' ') words)"
  else
    echo "    FAILED"
  fi
done

echo ""
echo "========================================"
echo "  Transcription complete!"
echo "  Transcribed: $DONE"
echo "  Skipped (already done): $SKIPPED"
echo "========================================"
