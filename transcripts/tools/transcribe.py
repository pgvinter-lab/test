"""Local ASR pass over the automixed court audio.

Pipeline per segment:
  mono automix -> Silero VAD -> speaker-homogeneous windows (<=28s) -> Whisper medium.en

Each VAD speech region is tagged with the microphone that dominated it (from the
per-frame channel energies produced by automix.py). Consecutive regions sharing a
microphone are merged into one Whisper window, so a window never straddles two
speakers and every transcribed line carries a reliable mic attribution.
"""
import json, os, sys, time
import numpy as np
import soundfile as sf
import sherpa_onnx

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "models", "sherpa-onnx-whisper-medium.en")
VAD = os.path.join(HERE, "models", "silero_vad.onnx")
SR = 16000
MAX_WIN = 26.0        # keep under Whisper's 30s receptive field
FRAME_SEC = 256 / SR  # must match automix.py FRAME


def build_vad():
    c = sherpa_onnx.VadModelConfig()
    c.silero_vad.model = VAD
    c.silero_vad.threshold = 0.45
    c.silero_vad.min_silence_duration = 0.35
    c.silero_vad.min_speech_duration = 0.20
    c.silero_vad.max_speech_duration = 20.0
    c.sample_rate = SR
    return sherpa_onnx.VoiceActivityDetector(c, buffer_size_in_seconds=180)


def build_asr(precision):
    suf = ".int8" if precision == "int8" else ""
    return sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=f"{MODEL}/medium.en-encoder{suf}.onnx",
        decoder=f"{MODEL}/medium.en-decoder{suf}.onnx",
        tokens=f"{MODEL}/medium.en-tokens.txt",
        num_threads=int(os.environ.get("NT","1")),
        decoding_method="greedy_search",
        language="en",
        task="transcribe",
    )


def vad_regions(vad, audio):
    """Return [(start_s, end_s)] speech regions."""
    out, step = [], 4096
    for i in range(0, len(audio), step):
        vad.accept_waveform(audio[i:i + step])
        while not vad.empty():
            s = vad.front
            out.append((s.start / SR, (s.start + len(s.samples)) / SR))
            vad.pop()
    vad.flush()
    while not vad.empty():
        s = vad.front
        out.append((s.start / SR, (s.start + len(s.samples)) / SR))
        vad.pop()
    return out


def dominant_mic(energy, t0, t1):
    """Which channel carried this region, plus how decisive that was."""
    a, b = int(t0 / FRAME_SEC), max(int(t1 / FRAME_SEC), int(t0 / FRAME_SEC) + 1)
    e = energy[a:b]
    if len(e) == 0:
        return 0, 0.0
    tot = e.sum(axis=0)
    if tot.sum() <= 0:
        return 0, 0.0
    share = tot / tot.sum()
    k = int(share.argmax())
    return k, float(share[k])


def windows(regions, energy):
    """Merge same-mic adjacent regions into <=MAX_WIN windows."""
    tagged = [(t0, t1) + dominant_mic(energy, t0, t1) for t0, t1 in regions]
    out, cur = [], None
    for t0, t1, mic, conf in tagged:
        if (cur and cur["mic"] == mic and t1 - cur["start"] <= MAX_WIN
                and t0 - cur["end"] < 1.2):
            cur["end"] = t1
            cur["confs"].append(conf)
        else:
            if cur:
                out.append(cur)
            cur = {"start": t0, "end": t1, "mic": mic, "confs": [conf]}
    if cur:
        out.append(cur)
    for w in out:
        w["conf"] = float(np.mean(w["confs"]))
        del w["confs"]
    return out


def main():
    precision = sys.argv[1] if len(sys.argv) > 1 else "int8"
    only = sys.argv[2] if len(sys.argv) > 2 else None
    limit = float(sys.argv[3]) if len(sys.argv) > 3 else None

    meta = json.load(open(os.path.join(HERE, "mix", "meta.json")))
    asr = build_asr(precision)
    os.makedirs(os.path.join(HERE, "out"), exist_ok=True)

    for m in meta:
        stem = m["stem"]
        if only and stem != only:
            continue
        audio, _ = sf.read(os.path.join(HERE, "mix", f"{stem}.wav"), dtype="float32")
        energy = np.load(os.path.join(HERE, "mix", f"{stem}_energy.npy"))
        if limit:
            audio = audio[: int(limit * SR)]

        t = time.time()
        regs = vad_regions(build_vad(), audio)
        wins = windows(regs, energy)
        speech = sum(w["end"] - w["start"] for w in wins)
        print(f"[{stem}] {len(regs)} regions -> {len(wins)} windows, "
              f"{speech:.0f}s speech / {len(audio)/SR:.0f}s", flush=True)

        rows = []
        for i, w in enumerate(wins):
            a, b = int(w["start"] * SR), int(w["end"] * SR)
            s = asr.create_stream()
            s.accept_waveform(SR, audio[a:b])
            asr.decode_stream(s)
            txt = s.result.text.strip()
            if txt:
                rows.append({"start": round(w["start"], 2), "end": round(w["end"], 2),
                             "mic": w["mic"], "conf": round(w["conf"], 3), "text": txt})
            if (i + 1) % 20 == 0:
                el = time.time() - t
                print(f"  {i+1}/{len(wins)}  {el:.0f}s elapsed "
                      f"({speech/max(el,1e-9):.2f}x realtime)", flush=True)

        json.dump(rows, open(os.path.join(HERE, "out", f"{stem}.json"), "w"), indent=1)
        print(f"[{stem}] done in {time.time()-t:.0f}s -> {len(rows)} utterances", flush=True)


if __name__ == "__main__":
    main()
