// Build the Word version of the hearing transcript from the same JSON sources
// the markdown is generated from, so the two never drift.
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  PageBreak, Header, Footer, PageNumber, TabStopType, TabStopPosition,
} = require("docx");

const TDIR = "/home/user/test/transcripts";
const OUT = process.argv[2] || path.join(TDIR, "6-30-26 Hearing Transcript.docx");
const HEARING_DATE = "June 30, 2026";

const man = JSON.parse(fs.readFileSync(path.join(TDIR, "manifest.json")));
const roles = JSON.parse(fs.readFileSync(path.join(TDIR, "speakers.json")));
const names = JSON.parse(fs.readFileSync(path.join(TDIR, "names.json")));

const FONT = "Times New Roman";
const CONTENT_W = 9360;            // 8.5in page less 1in margins, in DXA
const ARRIVAL_SEC = 1050;          // respondent announced as present

const hhmmss = (t) => [t / 3600, (t % 3600) / 60, t % 60]
  .map((n) => String(Math.floor(n)).padStart(2, "0")).join(":");

const NONSPEECH = /^[([][^)\]]*[)\]][.\s]*$|^\[BLANK_AUD.*$/i;
const FILLER = new Set(["you", "you.", "thank you.", "thanks.", "bye.", ">> go.", "go."]);
const isNonSpeech = (t) =>
  NONSPEECH.test(t.trim()) || FILLER.has(t.trim().toLowerCase());

const roleFor = (mic, absT) =>
  (mic === 1 && absT < ARRIVAL_SEC)
    ? "UNATTRIBUTED — low confidence"
    : (roles[String(mic)] || {}).label || `MIC ${mic}`;

// ---------- small builders ----------
const p = (text, o = {}) => new Paragraph({
  alignment: o.align,
  spacing: { before: o.before ?? 0, after: o.after ?? 120, line: o.line ?? 276 },
  indent: o.indent,
  children: [new TextRun({
    text, font: FONT, size: o.size ?? 22,
    bold: o.bold, italics: o.italics, color: o.color, allCaps: o.caps,
  })],
});

const runs = (children, o = {}) => new Paragraph({
  alignment: o.align,
  spacing: { before: o.before ?? 0, after: o.after ?? 120, line: 276 },
  indent: o.indent,
  children,
});

const cell = (children, width, o = {}) => new TableCell({
  width: { size: width, type: WidthType.DXA },
  shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: "auto" } : undefined,
  margins: { top: 60, bottom: 60, left: 100, right: 100 },
  children,
});

function table(widths, rows, opts = {}) {
  return new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    rows: rows.map((cells, ri) => new TableRow({
      tableHeader: ri === 0 && opts.header,
      children: cells.map((c, ci) => cell(
        [p(c, { size: 19, bold: ri === 0 && opts.header, after: 0 })],
        widths[ci],
        { fill: ri === 0 && opts.header ? "E8E8E8" : undefined },
      )),
    })),
  });
}

// ---------- document body ----------
const body = [];

body.push(p("COURT HEARING", { align: AlignmentType.CENTER, size: 32, bold: true, after: 40 }));
body.push(p("Audio Transcript", { align: AlignmentType.CENTER, size: 26, after: 40 }));
body.push(p(`Hearing of ${HEARING_DATE}`, { align: AlignmentType.CENTER, size: 22, after: 260 }));

// Draft warning, boxed
const warn = [
  "DRAFT — MACHINE-GENERATED TRANSCRIPT. NOT A CERTIFIED OR OFFICIAL RECORD.",
  "Produced by automated speech recognition from the courtroom's multi-microphone recording. "
  + "It has not been reviewed against the audio by a human, and is not a substitute for the "
  + "official transcript prepared by a certified court reporter.",
  "Names, figures, dates, and legal citations are the least reliable parts of any speech-recognition "
  + "output and must be verified against the audio before any use. See the Names table below for the "
  + "variants the recogniser produced for each person.",
];
body.push(new Table({
  columnWidths: [CONTENT_W],
  width: { size: CONTENT_W, type: WidthType.DXA },
  rows: [new TableRow({
    children: [cell([
      p(warn[0], { bold: true, size: 20, after: 100 }),
      p(warn[1], { size: 20, after: 100 }),
      p(warn[2], { size: 20, after: 0 }),
    ], CONTENT_W, { fill: "FDF2F2" })],
  })],
}));
body.push(p("", { after: 240 }));

// Recording
const total = man.segments.reduce((a, s) => a + s.duration_sec, 0);
body.push(p("Recording", { bold: true, size: 26, after: 140 }));
body.push(table([2600, 6760], [
  ["Segments", String(man.segments.length)],
  ["Total duration", `${hhmmss(total)}  (${Math.round(total / 60)} minutes)`],
  ["Audio format", "4-channel Ogg Vorbis, 16 kHz — one channel per courtroom microphone"],
  ["Transcribed", man.built],
  ["Method", man.method],
]));
body.push(p("", { after: 240 }));

body.push(p("Source files", { bold: true, size: 24, after: 140 }));
body.push(table([560, 4200, 1600, 3000], [
  ["#", "File", "Duration", "SHA-256 (first 16)"],
  ...man.segments.map((s) => [
    String(s.index + 1), s.source, hhmmss(s.duration_sec), s.sha256.slice(0, 16),
  ]),
], { header: true }));
body.push(p("", { after: 240 }));

// Speakers
body.push(p("Speakers", { bold: true, size: 26, after: 140 }));
body.push(p(
  "Each courtroom microphone is on its own audio channel, so speaker attribution comes from which "
  + "microphone carried the speech, not from voice-matching. That makes it reliable for who spoke "
  + "when, but the mapping from microphone to person below is inferred from what is said and should "
  + "be confirmed.", { size: 20, after: 140 }));
body.push(table([620, 2900, 5840], [
  ["Mic", "Speaker", "Basis"],
  ...Object.keys(roles).sort().map((k) => [k, roles[k].label, roles[k].basis || "—"]),
], { header: true }));
body.push(p("", { after: 140 }));
body.push(runs([
  new TextRun({ text: "A paragraph is not a single speaker. ", font: FONT, size: 20, bold: true }),
  new TextRun({
    text: "Attribution is per passage of audio, not per sentence, so a paragraph tagged to counsel's "
      + "table will usually contain both the question and the witness's answer. Read the label as where "
      + "the passage came from, not as who said every word in it. Separating question from answer is a "
      + "job for human review against the audio. Passages marked “overlap” had two microphones "
      + "live at once.",
    font: FONT, size: 20,
  }),
]));

body.push(new Paragraph({ children: [new PageBreak()] }));

// Names
body.push(p("Names", { bold: true, size: 26, after: 140 }));
body.push(p(names.note, { size: 20, after: 140 }));
body.push(table([2200, 2400, 3760, 1000], [
  ["Best guess", "Role", "Heard in the audio as", "Verified"],
  ...names.entries.map((e) => [
    e.best_guess, e.role, e.heard_as.join(", "), String(e.verified),
  ]),
], { header: true }));
body.push(p("", { after: 140 }));
body.push(p(
  "Names appear in the transcript body exactly as the recogniser produced them, not silently "
  + "corrected to the spellings above — so nothing in the record below is a guess dressed up as "
  + "speech. Use this table to read through the variants.", { size: 20, after: 0 }));

body.push(new Paragraph({ children: [new PageBreak()] }));

// Transcript body
for (const s of man.segments) {
  const f = path.join(TDIR, "data", `${s.stem}.json`);
  if (!fs.existsSync(f)) continue;
  const rows = JSON.parse(fs.readFileSync(f));
  const off = s.offset_sec;

  body.push(p(
    `Segment ${s.index + 1} — ${hhmmss(off)} to ${hhmmss(off + s.duration_sec)}`,
    { bold: true, size: 26, before: 240, after: 60 }));
  body.push(p(`Source: ${s.source}`, { size: 18, italics: true, color: "666666", after: 180 }));

  let last = null;
  for (const r of rows) {
    const absT = off + r.start;
    const t = hhmmss(absT);

    if (isNonSpeech(r.text)) {
      body.push(p(`${t}   ${r.text.trim()}  (non-speech; no speaker)`,
        { size: 18, italics: true, color: "666666", after: 100 }));
      last = null;
      continue;
    }

    const spk = roleFor(r.mic, absT);
    if (spk !== last) {
      body.push(new Paragraph({
        spacing: { before: 200, after: 60, line: 276 },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [
          new TextRun({ text: spk, font: FONT, size: 22, bold: true }),
          ...(r.conf < 0.55
            ? [new TextRun({ text: "  (overlap)", font: FONT, size: 18, italics: true, color: "888888" })]
            : []),
          new TextRun({ text: `\t${t}`, font: FONT, size: 18, color: "666666" }),
        ],
      }));
      last = spk;
    } else {
      body.push(new Paragraph({
        spacing: { before: 120, after: 60, line: 276 },
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        children: [new TextRun({ text: `\t${t}`, font: FONT, size: 18, color: "666666" })],
      }));
    }
    body.push(p(r.text, { indent: { left: 360 }, after: 60 }));
  }

  body.push(p("", { after: 60 }));
  body.push(new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } },
    spacing: { after: 160 },
    children: [],
  }));
}

body.push(p(
  "End of transcript. Further recording segments will be appended to this document as they are provided.",
  { size: 18, italics: true, color: "666666", before: 200 }));

const doc = new Document({
  creator: "Automated transcription pipeline",
  title: "Court Hearing — Audio Transcript",
  description: `Draft machine-generated transcript of the hearing of ${HEARING_DATE}`,
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },      // US Letter
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: {
      default: new Header({
        children: [p("DRAFT — machine-generated; not a certified record",
          { align: AlignmentType.CENTER, size: 16, color: "888888", after: 0 })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({
            children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES],
            font: FONT, size: 18, color: "666666",
          })],
        })],
      }),
    },
    children: body,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} (${(buf.length / 1024).toFixed(0)} KB)`);
});
