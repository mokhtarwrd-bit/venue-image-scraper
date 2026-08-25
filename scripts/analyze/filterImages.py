#!/usr/bin/env python3
# =============================================================================
# analyze/filterImages.py  —  STAGE A local image filter (Pillow + numpy).
#
# This is Stage A ONLY (per the Phase 2a brief). It is the cheap, deterministic,
# offline pre-filter that runs before any vision model. It does NOT do section
# routing or brand-DNA — that is Stage B / Phase 2b.
#
# What it does, one image at a time:
#   - reject below minimum resolution           -> rejected/below_min_resolution
#   - reject blur (variance-of-Laplacian low)    -> rejected/too_blurry
#   - reject too dark / blown highlights         -> rejected/too_dark
#   - bucket survivors by aspect ratio into
#     hero/landscape candidates vs square/portrait candidates (recorded in JSON;
#     survivors are MOVED to images/unsorted/ for the Stage B pass in 2b)
#
# Decidable without a model; uses cv2-free numpy Laplacian so no OpenCV needed.
# Emits a JSON report to stdout (and writes stage-a-report.json next to images/).
#
# Usage:
#   python filterImages.py <lead_images_dir> [--min-w 1000] [--min-h 1000]
#       [--blur 100] [--dark 35] [--bright 250]
# <lead_images_dir> must contain an `_incoming/` folder of raw downloads and the
# sibling `unsorted/` and `rejected/` folders (created by the Node orchestrator).
# =============================================================================

import sys, os, json, argparse, shutil
import numpy as np
from PIL import Image, ImageOps

# Stage-A reject reason codes (subset of spec REJECT_CODES that are decidable
# locally without a vision model).
R_LOWRES = "below_min_resolution"
R_BLUR   = "too_blurry"
R_DARK   = "too_dark"

def variance_of_laplacian(gray: np.ndarray) -> float:
    """cv2-free focus measure: variance of the Laplacian (4-neighbour kernel).
    Low variance => few edges => blurry. Standard, well-understood metric."""
    g = gray.astype(np.float64)
    lap = (
        -4.0 * g
        + np.roll(g, 1, axis=0) + np.roll(g, -1, axis=0)
        + np.roll(g, 1, axis=1) + np.roll(g, -1, axis=1)
    )
    # Trim the 1px border (roll wraps around) so edges don't skew the variance.
    return float(lap[1:-1, 1:-1].var())

def aspect_bucket(w: int, h: int) -> str:
    """Spec §2.1 orientation buckets."""
    if h == 0:
        return "unknown"
    r = w / h
    if r >= 16 / 9 - 0.05:
        return "landscape_wide"   # >= ~16:9  -> hero / full-bleed
    if r >= 1.2:
        return "landscape"        # 3:2-4:3   -> gallery/interior/exterior
    if r > 0.83:
        return "square"           # ~1:1      -> grids, food tiles
    return "portrait"             # <= 3:4    -> mobile hero / verticals

def analyze_one(path, args):
    """Return (verdict, info). verdict is None to keep, or a reject code."""
    try:
        im = Image.open(path)
        im = ImageOps.exif_transpose(im)  # honour orientation so w/h are true
        im = im.convert("RGB")
    except Exception as e:
        return (R_LOWRES, {"error": f"unreadable:{e}"})

    w, h = im.size
    info = {"width": w, "height": h, "aspect_bucket": aspect_bucket(w, h)}

    # 1) resolution gate — LONG-EDGE + SHORT-EDGE model (not min on both axes).
    #    A website-usable hero is wide: e.g. 1440x960 is great but would fail a
    #    naive "both axes >= 1000" AND-gate on its 960 height. The honest test
    #    of usability is: the long edge clears a threshold (enough pixels to fill
    #    a section) AND the short edge clears a smaller floor (not a sliver/thumb).
    long_edge, short_edge = max(w, h), min(w, h)
    if long_edge < args.min_long or short_edge < args.min_short:
        info["reason_detail"] = (
            f"long {long_edge} < {args.min_long} or short {short_edge} < {args.min_short}"
        )
        return (R_LOWRES, info)

    arr = np.asarray(im, dtype=np.float64)
    # luminance (Rec. 601)
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    mean_lum = float(lum.mean())
    info["mean_luminance"] = round(mean_lum, 1)

    # 2) brightness gate: too dark (muddy) or fully blown
    if mean_lum < args.dark:
        info["reason_detail"] = f"mean_luminance {mean_lum:.0f} < {args.dark}"
        return (R_DARK, info)
    if mean_lum > args.bright:
        info["reason_detail"] = f"mean_luminance {mean_lum:.0f} > {args.bright} (blown)"
        return (R_DARK, info)  # blown-out is bucketed under too_dark/unusable exposure

    # 3) blur gate: variance of Laplacian on a downscaled gray (speed + stability)
    small = im.convert("L")
    if max(small.size) > 1024:
        small.thumbnail((1024, 1024))
    blur = variance_of_laplacian(np.asarray(small))
    info["focus_var"] = round(blur, 1)
    if blur < args.blur:
        info["reason_detail"] = f"focus_var {blur:.0f} < {args.blur}"
        return (R_BLUR, info)

    return (None, info)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("images_dir")
    # Long-edge floor: enough pixels to fill a hero/section at retina (~1200+).
    # Short-edge floor: rejects slivers/banners/thumbnails while letting true
    # landscapes (e.g. 1440x960) and portraits through.
    ap.add_argument("--min-long", type=int, default=1100)
    ap.add_argument("--min-short", type=int, default=640)
    ap.add_argument("--blur", type=float, default=100.0)
    ap.add_argument("--dark", type=float, default=35.0)
    ap.add_argument("--bright", type=float, default=250.0)
    args = ap.parse_args()

    images_dir = os.path.abspath(args.images_dir)
    incoming = os.path.join(images_dir, "_incoming")
    unsorted = os.path.join(images_dir, "unsorted")
    rejected = os.path.join(images_dir, "rejected")
    for d in (unsorted, rejected):
        os.makedirs(d, exist_ok=True)

    if not os.path.isdir(incoming):
        print(json.dumps({"error": f"no _incoming dir at {incoming}"}))
        sys.exit(1)

    results = []
    counts = {"kept": 0, R_LOWRES: 0, R_BLUR: 0, R_DARK: 0}
    buckets = {}

    files = sorted(f for f in os.listdir(incoming)
                   if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp", ".avif")))

    for fn in files:
        src = os.path.join(incoming, fn)
        verdict, info = analyze_one(src, args)
        rec = {"file": fn, **info}
        if verdict is None:
            # survivor -> unsorted/ (Stage B section routing happens in 2b)
            dst = os.path.join(unsorted, fn)
            shutil.move(src, dst)
            rec["kept"] = True
            rec["moved_to"] = os.path.relpath(dst, images_dir)
            counts["kept"] += 1
            b = info.get("aspect_bucket", "unknown")
            buckets[b] = buckets.get(b, 0) + 1
        else:
            rdir = os.path.join(rejected, verdict)
            os.makedirs(rdir, exist_ok=True)
            dst = os.path.join(rdir, fn)
            shutil.move(src, dst)
            rec["kept"] = False
            rec["reject_code"] = verdict
            rec["moved_to"] = os.path.relpath(dst, images_dir)
            counts[verdict] = counts.get(verdict, 0) + 1
        results.append(rec)

    report = {
        "stage": "A",
        "images_dir": images_dir,
        "params": {"min_long": args.min_long, "min_short": args.min_short,
                   "blur": args.blur, "dark": args.dark, "bright": args.bright},
        "total": len(files),
        "counts": counts,
        "survivor_buckets": buckets,
        "results": results,
    }
    with open(os.path.join(images_dir, "stage-a-report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps({k: report[k] for k in ("total", "counts", "survivor_buckets")}, indent=2))

if __name__ == "__main__":
    main()
