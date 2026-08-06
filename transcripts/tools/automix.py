"""Dugan-style automatic microphone mixer for multi-channel court audio.

Produces (a) a clean mono mixdown for ASR and (b) per-frame channel energies
used later to attribute each transcript segment to a microphone.
"""
import soundfile as sf, numpy as np, sys, os, json

FRAME = 256          # 16 ms @ 16 kHz
SMOOTH = 12          # ~200 ms attack/release smoothing

def process(path, outwav, outnpy):
    d, sr = sf.read(path, dtype='float32')
    n, ch = d.shape
    nf = n // FRAME
    d = d[:nf*FRAME]
    fr = d.reshape(nf, FRAME, ch)

    # per-frame energy per channel
    e = (fr**2).mean(axis=1)                      # (nf, ch)

    # smooth energies so gains don't chatter mid-word
    k = np.ones(SMOOTH) / SMOOTH
    es = np.stack([np.convolve(e[:, c], k, mode='same') for c in range(ch)], axis=1)

    # per-channel noise floor -> subtract so an idle mic never wins
    floor = np.percentile(es, 20, axis=0)
    esn = np.maximum(es - floor, 0.0)

    # Dugan gain: each channel's share of total energy
    tot = esn.sum(axis=1, keepdims=True) + 1e-12
    gain = esn / tot                              # (nf, ch), rows sum to 1

    mixed = (fr * gain[:, None, :]).sum(axis=2).reshape(-1)

    # normalise to a comfortable level for ASR
    pk = np.percentile(np.abs(mixed), 99.9)
    if pk > 0:
        mixed = np.clip(mixed * (0.7 / pk), -1.0, 1.0)

    sf.write(outwav, mixed, sr, subtype='PCM_16')
    np.save(outnpy, esn.astype(np.float32))
    return dict(file=os.path.basename(path), frames=nf, sr=sr, channels=ch,
                frame_sec=FRAME/sr,
                floor=[float(x) for x in floor],
                active_share=[float(x) for x in (gain.argmax(axis=1) ==
                              np.arange(ch)[:, None]).T.mean(axis=0)])

if __name__ == '__main__':
    os.makedirs('mix', exist_ok=True)
    meta = []
    for i, p in enumerate(sys.argv[1:]):
        stem = f"seg{i:02d}"
        m = process(p, f"mix/{stem}.wav", f"mix/{stem}_energy.npy")
        m['stem'] = stem
        meta.append(m)
        print(stem, m['file'], 'ok')
    json.dump(meta, open('mix/meta.json', 'w'), indent=2)
