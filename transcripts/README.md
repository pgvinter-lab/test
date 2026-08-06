# Court audio transcripts

`court-hearing.md` is the transcript document. It is **generated**, not hand-edited —
it is rebuilt in full from `data/*.json` + `manifest.json` every time, so that adding
later recording segments never disturbs what is already there.

Do not edit `court-hearing.md` directly; edits there are overwritten on the next
build. Correct the inputs instead (`data/*.json` for wording, `speakers.json` for
the microphone map, `names.json` for spellings).

## Layout

| Path | What it is |
|---|---|
| `court-hearing.md` | The generated transcript. |
| `manifest.json` | Every source audio file: order, offset, duration, SHA-256. |
| `data/segNN.json` | Raw recogniser output per segment — timestamps, mic, confidence, text. |
| `speakers.json` | Microphone → courtroom position. Inferred; edit as it is confirmed. |
| `names.json` | Proper nouns with the variants the recogniser produced. All `verified:false`. |
| `tools/` | The pipeline (see below). |

Audio itself is deliberately **not** committed — the manifest carries the SHA-256 of
each source file so a segment can be matched back to its recording.

## Adding the next batch of audio

The segments are 10 minutes each and are ordered by the trailing number in the
upload filename (`…thg6e300`, `…thg6e301`, …), which is what defines their
chronological order — not alphabetical filename order. Keep new files in their own
recorded order when passing them in.

```bash
cd tools

# 1. Automix the 4 mic channels down to mono + capture per-channel energy.
#    Pass the new .ogg files in chronological order.
python3 automix.py /path/to/new1.ogg /path/to/new2.ogg ...

# 2. Transcribe. One process per segment; each takes roughly 45 min on 4 cores.
for s in seg00 seg01 ...; do NT=1 python3 transcribe.py int8 $s & done; wait

# 3. Append to the manifest and copy results into data/ (existing segments are
#    left alone; offsets continue from the end of the current recording).
python3 make_manifest.py

# 4. Rebuild the document.
python3 build_doc.py
```

`make_manifest.py` keys off the source filename, so re-running it is safe — a file
already in the manifest is skipped rather than duplicated.

## How it works, and what that means for accuracy

The recording has one microphone per channel (bench, respondent, plaintiff's table,
clerk). The pipeline exploits that:

1. **Automix** — a Dugan-style automatic mixer weights each channel by its share of
   the frame's energy, so the speaking mic dominates and the other three are
   attenuated. This suppresses the room noise and reverb that a naive channel sum
   would pile up, and gives the recogniser a much cleaner signal.
2. **VAD** — Silero voice-activity detection finds speech and drops silence.
3. **Windowing** — adjacent speech sharing the same dominant microphone is merged
   into windows of ≤26 s (Whisper reads 30 s at a time).
4. **ASR** — Whisper `medium.en`, ONNX int8, run locally in-session. No audio leaves
   the machine.
5. **Attribution** — each window is tagged with the microphone that carried it.

The limits worth knowing:

- **Attribution is per passage, not per sentence.** A window tagged to counsel's
  table normally contains both the question and the witness's answer. The tag says
  where the audio came from, not who said every word.
- **Mic 0 serves both the bench and the witness stand** — they are adjacent. It
  carries the judge early on and the witness after she was moved to the stand.
- **Names are unreliable** and are left exactly as recognised rather than silently
  corrected; `names.json` holds the variants and the best guess for each.
- Passages marked *(overlap)* had two microphones live at once.

Nothing here has been checked against the audio by a human. It is a working draft,
not a certified record.
