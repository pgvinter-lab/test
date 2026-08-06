"""Record what audio went into the transcript, so later batches append cleanly."""
import json, os, hashlib, datetime, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TDIR = os.path.dirname(HERE) if os.path.basename(HERE) == "tools" else os.getcwd()
DATA = os.path.join(TDIR, "data")
SEG_SEC = 600.0

METHOD = ("4-channel Dugan-style automix -> Silero VAD -> OpenAI Whisper medium.en "
          "(ONNX int8, sherpa-onnx), run locally in-session; speaker attribution "
          "from per-microphone channel energy")


def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def main():
    os.makedirs(DATA, exist_ok=True)
    mix = json.load(open(os.path.join(HERE, "mix", "meta.json")))

    mpath = os.path.join(TDIR, "manifest.json")
    man = json.load(open(mpath)) if os.path.exists(mpath) else {"segments": []}
    known = {s["source"] for s in man["segments"]}
    idx = len(man["segments"])

    for m in mix:
        if m["file"] in known:
            continue
        src = m.get("path")
        man["segments"].append({
            "index": idx,
            "stem": f"seg{idx:02d}",
            "source": m["file"],
            "duration_sec": SEG_SEC,
            "offset_sec": idx * SEG_SEC,
            "sha256": sha256(src) if src and os.path.exists(src) else "",
            "channels": m["channels"],
            "sample_rate": m["sr"],
        })
        shutil.copy(os.path.join(HERE, "out", f"{m['stem']}.json"),
                    os.path.join(DATA, f"seg{idx:02d}.json"))
        idx += 1

    man["built"] = datetime.date.today().isoformat()
    man["method"] = METHOD
    json.dump(man, open(mpath, "w"), indent=2)
    print(f"manifest: {len(man['segments'])} segments")


if __name__ == "__main__":
    main()
