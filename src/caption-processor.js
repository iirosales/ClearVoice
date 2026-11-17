const HTML_ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

const TECH_JARGON_RULES = [
  [/\bcube\s+ernettes\b/gi, 'Kubernetes'],
  [/\bkubernetis\b/gi, 'Kubernetes'],
  [/\bmy\s+sequel\b/gi, 'MySQL'],
  [/\bpost\s*gres(?:\s+sequel)?\b/gi, 'PostgreSQL'],
  [/\bsequel\b/gi, 'SQL'],
  [/\bjason\b/gi, 'JSON'],
  [/\bget\s+hub\b/gi, 'GitHub'],
  [/\bget\s+lab\b/gi, 'GitLab'],
  [/\bengine\s+x\b/gi, 'Nginx'],
  [/\bnode\s+js\b/gi, 'Node.js'],
  [/\breact\s+js\b/gi, 'React.js'],
  [/\bvue\s+js\b/gi, 'Vue.js'],
  [/\bnext\s+js\b/gi, 'Next.js'],
  [/\btype\s+script\b/gi, 'TypeScript'],
  [/\bjava\s+script\b/gi, 'JavaScript'],
  [/\bfast\s+api\b/gi, 'FastAPI'],
  [/\bopen\s+ai\b/gi, 'OpenAI'],
  [/\bweb\s+gpu\b/gi, 'WebGPU'],
  [/\bweb\s+assembly\b/gi, 'WebAssembly'],
  [/\bdocker\s+file\b/gi, 'Dockerfile'],
];

const PAUSE_SPLIT_MS = 450;
const MIN_WORDS_FOR_PUNCT_SPLIT = 3;
const CLAUSE_SPLIT_WORD_THRESHOLD = 7;
const MAX_WORDS_PER_CUE = 12;
const MIN_CUE_DURATION_SEC = 0.4;
const ABBREVIATION_END_RE = /\b(?:mr|mrs|ms|dr|prof|sr|jr|vs|etc|e\.g|i\.e|fig|no)\.\s*$/i;

/**
 * Decode common named and numeric HTML entities found in YouTube caption segments.
 */
export function decodeHtmlEntities(text) {
  if (!text) return '';
  return text
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (match) => {
      const key = match.toLowerCase();
      return HTML_ENTITY_MAP[key] ?? match;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });
}

/**
 * Normalize common programming/CS auto-caption misrecognitions for clearer TTS pronunciation.
 */
export function normalizeTechJargon(text) {
  if (!text) return '';
  let result = text;
  for (const [pattern, replacement] of TECH_JARGON_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Strip non-speech annotations ([Music], [Applause], etc.), decode entities, and normalize whitespace.
 */
export function cleanSegmentText(rawText) {
  if (!rawText) return '';
  let text = decodeHtmlEntities(rawText);
  // Strip bracketed non-speech markers like [Music], [Applause], [Laughter]
  text = text.replace(/\[[^\]]*\]/g, ' ');
  // Strip parenthesized common non-speech tags
  text = text.replace(/\((?:music|applause|laughter|cheering|sighs|gasps|silence)\)/gi, ' ');
  // Strip musical symbols
  text = text.replace(/[♪♫]+/g, ' ');
  // Normalize whitespace and newlines
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function endsWithTerminalPunctuation(text) {
  const trimmed = text.trim();
  if (!/[.!?]["')\]]*$/.test(trimmed)) return false;
  if (/\.\.\.["')\]]*$/.test(trimmed)) return false;
  return !ABBREVIATION_END_RE.test(trimmed);
}

function endsWithClausePunctuation(text) {
  return /[,;:—]["')\]]*$/.test(text.trim());
}

function extractEventText(event) {
  if (!event || !Array.isArray(event.segs)) return '';
  const combined = event.segs.map((seg) => seg?.utf8 || '').join('');
  return cleanSegmentText(combined);
}

/**
 * Merge fragmented YouTube json3 caption events into natural sentence cues
 * with accurate start/end timestamps and cleaned technical terminology.
 *
 * @param {Array<object>} events Raw YouTube json3 `events` array
 * @returns {Array<{id: number, text: string, startSec: number, endSec: number, durationSec: number}>}
 */
export function processCaptionEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return [];

  // Step 1: Extract valid timed speech events using segment offsets to estimate true spoken ends
  const validEvents = [];
  for (const ev of events) {
    if (typeof ev?.tStartMs !== 'number' || ev.tStartMs < 0) continue;
    const text = extractEventText(ev);
    if (!text) continue;

    let firstOffsetMs = 0;
    let lastOffsetMs = 0;
    for (const seg of ev.segs) {
      if (typeof seg?.tOffsetMs === 'number' && seg.tOffsetMs >= 0) {
        if (firstOffsetMs === 0 && seg.tOffsetMs > 0) {
          firstOffsetMs = seg.tOffsetMs;
        }
        lastOffsetMs = Math.max(lastOffsetMs, seg.tOffsetMs);
      }
    }

    const startMs = ev.tStartMs + firstOffsetMs;
    const rawDurationMs =
      typeof ev.dDurationMs === 'number' && ev.dDurationMs > 0 ? ev.dDurationMs : 2000;
    const rawEndMs = ev.tStartMs + rawDurationMs;
    const wordCount = countWords(text);
    const estimatedSpeechMs = Math.max(400, wordCount * 320);

    // YouTube auto-captions set dDurationMs to rolling display window (~4-5s), not spoken length
    const spokenEndMs =
      lastOffsetMs > 0
        ? ev.tStartMs + lastOffsetMs + 350
        : Math.min(rawEndMs, startMs + estimatedSpeechMs + 250);

    validEvents.push({
      text,
      startMs,
      spokenEndMs,
      wordCount,
    });
  }

  if (validEvents.length === 0) return [];

  // Step 2: Merge consecutive fragments into crisp 6-12 word sentence/clause cues
  const rawCues = [];
  let current = {
    textParts: [validEvents[0].text],
    startMs: validEvents[0].startMs,
    spokenEndMs: validEvents[0].spokenEndMs,
    wordCount: validEvents[0].wordCount,
  };

  for (let i = 1; i < validEvents.length; i++) {
    const ev = validEvents[i];
    const gapMs = ev.startMs - current.spokenEndMs;
    const currentText = current.textParts.join(' ');

    const hasTerminal = endsWithTerminalPunctuation(currentText);
    const hasClause = endsWithClausePunctuation(currentText);

    const shouldSplit =
      gapMs > PAUSE_SPLIT_MS ||
      (hasTerminal && current.wordCount >= MIN_WORDS_FOR_PUNCT_SPLIT) ||
      current.wordCount + ev.wordCount > MAX_WORDS_PER_CUE ||
      (hasClause && current.wordCount >= CLAUSE_SPLIT_WORD_THRESHOLD);

    if (shouldSplit) {
      rawCues.push({
        text: normalizeTechJargon(currentText),
        startMs: current.startMs,
        spokenEndMs: current.spokenEndMs,
      });
      current = {
        textParts: [ev.text],
        startMs: ev.startMs,
        spokenEndMs: ev.spokenEndMs,
        wordCount: ev.wordCount,
      };
    } else {
      current.textParts.push(ev.text);
      current.spokenEndMs = Math.max(current.spokenEndMs, ev.spokenEndMs);
      current.wordCount += ev.wordCount;
    }
  }

  rawCues.push({
    text: normalizeTechJargon(current.textParts.join(' ')),
    startMs: current.startMs,
    spokenEndMs: current.spokenEndMs,
  });

  // Step 3: Compute clean non-overlapping seconds timestamps without artificially tight windows
  const finalCues = [];
  for (let i = 0; i < rawCues.length; i++) {
    const cue = rawCues[i];
    const cleanedText = cue.text.replace(/\s+/g, ' ').trim();
    if (!cleanedText) continue;

    const cueWordCount = countWords(cleanedText);
    const startSec = cue.startMs / 1000;
    const rawEndSec = Math.max(
      cue.spokenEndMs / 1000,
      startSec + Math.max(0.6, cueWordCount * 0.34)
    );
    let endSec = rawEndSec;

    if (i + 1 < rawCues.length) {
      const nextStartSec = rawCues[i + 1].startMs / 1000;
      if (nextStartSec > startSec) {
        const naturalWindowEnd = Math.min(nextStartSec - 0.05, startSec + cueWordCount * 0.42);
        endSec = Math.min(nextStartSec, Math.max(rawEndSec, naturalWindowEnd));
      }
    }

    if (endSec - startSec < MIN_CUE_DURATION_SEC) {
      endSec = startSec + MIN_CUE_DURATION_SEC;
    }

    finalCues.push({
      id: finalCues.length,
      text: cleanedText,
      startSec,
      endSec,
      durationSec: Number((endSec - startSec).toFixed(3)),
    });
  }

  return finalCues;
}
