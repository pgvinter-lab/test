"""Assemble the court transcript document from per-segment ASR output.

Rebuilds the whole document from transcripts/data/*.json + manifest.json, so
appending later audio is just: transcribe -> add to manifest -> re-run this.
"""
import json, os, sys, hashlib, datetime, re

REPO = "/home/user/test"
TDIR = os.path.join(REPO, "transcripts")
DATA = os.path.join(TDIR, "data")

# Microphone -> courtroom role. Set from observed content; unknown mics stay generic.
ROLES = json.load(open(os.path.join(TDIR, "speakers.json"))) if os.path.exists(
    os.path.join(TDIR, "speakers.json")) else {}


def hhmmss(t):
    return f"{int(t//3600):02d}:{int(t%3600//60):02d}:{int(t%60):02d}"


# Mr. Gvinter is announced as having "now appeared" at this absolute offset. Mic 1
# carries a few low-confidence passages before then which are therefore not him.
ARRIVAL_SEC = 1050.0

NONSPEECH = re.compile(r"^[\(\[][^)\]]*[\)\]][\.\s]*$|^\[BLANK_AUD.*$", re.I)
# Whisper's stock hallucinations over near-silence.
FILLER = {"you", "you.", "thank you.", "thanks.", "bye.", ">> go.", "go."}


def is_nonspeech(t):
    return bool(NONSPEECH.match(t.strip())) or t.strip().lower() in FILLER


def role(mic, abs_t):
    if mic == 1 and abs_t < ARRIVAL_SEC:
        return "UNATTRIBUTED — low confidence"
    return ROLES.get(str(mic), {}).get("label", f"MIC {mic}")


def main():
    man = json.load(open(os.path.join(TDIR, "manifest.json")))
    segs = man["segments"]

    lines = []
    A = lines.append
    A("# Court Hearing — Audio Transcript")
    A("")
    A("> **DRAFT — machine-generated transcript. Not a certified or official record.**")
    A("> Produced by automated speech recognition from the courtroom's multi-microphone")
    A("> recording. It has **not** been reviewed against the audio by a human, and is not")
    A("> a substitute for the official transcript prepared by a certified court reporter.")
    A("> Names, figures, dates, and legal citations are the least reliable parts of any")
    A("> ASR output and must be verified against the audio before any use — see **Names**")
    A("> below for the variants the recogniser produced for each person.")
    A("")

    total = sum(s["duration_sec"] for s in segs)
    A("## Recording")
    A("")
    A(f"| | |")
    A(f"|---|---|")
    A(f"| Segments | {len(segs)} |")
    A(f"| Total duration | {hhmmss(total)} ({total/60:.0f} min) |")
    A(f"| Audio format | 4-channel Ogg Vorbis, 16 kHz (one channel per courtroom mic) |")
    A(f"| Transcribed | {man['built']} |")
    A(f"| Method | {man['method']} |")
    A("")

    A("### Source files")
    A("")
    A("| # | File | Duration | SHA-256 (first 16) |")
    A("|---|---|---|---|")
    for s in segs:
        A(f"| {s['index']+1} | `{s['source']}` | {hhmmss(s['duration_sec'])} | `{s['sha256'][:16]}` |")
    A("")

    A("## Speakers")
    A("")
    A("Each courtroom microphone is on its own audio channel, so speaker attribution")
    A("comes from *which microphone carried the speech*, not from voice-matching. That")
    A("makes it reliable for who-spoke-when, but the mapping from microphone to person")
    A("below is inferred from what is said and should be confirmed.")
    A("")
    A("| Mic | Speaker | Basis |")
    A("|---|---|---|")
    for k in sorted(ROLES, key=int):
        r = ROLES[k]
        A(f"| {k} | **{r['label']}** | {r.get('basis','—')} |")
    A("")
    A("A line marked `(overlap)` had two microphones active at once — the attribution")
    A("there is the louder of the two and is less certain.")
    A("")
    A("**A paragraph is not a single speaker.** Attribution is per passage of audio, not")
    A("per sentence, so a paragraph tagged to counsel's table will usually contain both")
    A("the question and the witness's answer. Read the label as *where the passage came")
    A("from*, not as *who said every word in it*. Separating question from answer is a")
    A("job for human review against the audio.")
    A("")

    names = json.load(open(os.path.join(TDIR, "names.json")))
    A("## Names")
    A("")
    A(names["note"])
    A("")
    A("| Best guess | Role | Heard in the audio as | Verified |")
    A("|---|---|---|---|")
    for e in names["entries"]:
        heard = ", ".join(f"`{h}`" for h in e["heard_as"])
        A(f"| **{e['best_guess']}** | {e['role']} | {heard} | `{str(e['verified']).lower()}` |")
    A("")
    A("Names appear in the transcript body **exactly as the recogniser produced them**,")
    A("not silently corrected to the spellings above — so nothing in the record below is")
    A("a guess of mine dressed up as speech. Use this table to read through the variants.")
    A("")

    A("---")
    A("")

    for s in segs:
        p = os.path.join(DATA, f"{s['stem']}.json")
        if not os.path.exists(p):
            continue
        rows = json.load(open(p))
        off = s["offset_sec"]
        A(f"## Segment {s['index']+1} — {hhmmss(off)} to {hhmmss(off + s['duration_sec'])}")
        A("")
        A(f"<sub>Source: `{s['source']}`</sub>")
        A("")
        last = None
        for r in rows:
            abs_t = off + r["start"]
            t = hhmmss(abs_t)
            if is_nonspeech(r["text"]):
                A(f"<sub>`{t}` — *{r['text'].strip()}* (non-speech; no speaker)</sub>")
                A("")
                last = None
                continue
            spk = role(r["mic"], abs_t)
            mark = "" if r["conf"] >= 0.55 else " *(overlap)*"
            txt = r["text"]
            if spk != last:
                A(f"**{spk}**{mark} &nbsp;<sub>`{t}`</sub>")
                A("")
                last = spk
            else:
                A(f"<sub>`{t}`</sub>")
                A("")
            A(txt)
            A("")
        A("---")
        A("")

    A("<sub>End of transcript. Further recording segments will be appended to this")
    A("document as they are provided.</sub>")

    out = os.path.join(TDIR, "court-hearing.md")
    open(out, "w").write("\n".join(lines) + "\n")
    print("wrote", out, f"({len(lines)} lines)")


if __name__ == "__main__":
    main()
