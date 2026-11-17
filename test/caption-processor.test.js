import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeHtmlEntities,
  cleanSegmentText,
  normalizeTechJargon,
  processCaptionEvents,
} from '../src/caption-processor.js';

test('decodeHtmlEntities decodes named and numeric entities', () => {
  assert.equal(
    decodeHtmlEntities('React &amp; Vue &#39;rocks&#39; &quot;now&quot; &lt;tag&gt;&#x21;'),
    `React & Vue 'rocks' "now" <tag>!`
  );
});

test('cleanSegmentText strips non-speech tags and music symbols', () => {
  assert.equal(
    cleanSegmentText('[Music] Hello &amp; welcome ♪ [Applause] (laughter) to ClearVoice'),
    'Hello & welcome to ClearVoice'
  );
});

test('normalizeTechJargon fixes common CS auto-caption errors', () => {
  const input =
    'Today we deploy cube ernettes with sequel and jason from get hub behind engine x';
  const expected =
    'Today we deploy Kubernetes with SQL and JSON from GitHub behind Nginx';
  assert.equal(normalizeTechJargon(input), expected);

  assert.equal(
    normalizeTechJargon('Use type script with node js and web gpu on post gres'),
    'Use TypeScript with Node.js and WebGPU on PostgreSQL'
  );
});

test('processCaptionEvents merges small fragments into tight clauses', () => {
  const events = [
    { tStartMs: 1000, dDurationMs: 900, segs: [{ utf8: 'Welcome' }, { utf8: ' back' }] },
    { tStartMs: 1900, dDurationMs: 1100, segs: [{ utf8: 'to this' }] },
    { tStartMs: 3000, dDurationMs: 1200, segs: [{ utf8: 'cube ernettes' }] },
    { tStartMs: 4200, dDurationMs: 1000, segs: [{ utf8: 'tutorial.' }] },
    { tStartMs: 5300, dDurationMs: 1500, segs: [{ utf8: 'Let us inspect' }] },
    { tStartMs: 6800, dDurationMs: 1500, segs: [{ utf8: 'the jason config.' }] },
  ];

  const cues = processCaptionEvents(events);
  assert.equal(cues.length, 2);

  assert.equal(cues[0].id, 0);
  assert.equal(cues[0].text, 'Welcome back to this Kubernetes tutorial.');
  assert.equal(cues[0].startSec, 1.0);
  assert.ok(cues[0].endSec <= 5.3 && cues[0].endSec >= 4.0);

  assert.equal(cues[1].id, 1);
  assert.equal(cues[1].text, 'Let us inspect the JSON config.');
  assert.equal(cues[1].startSec, 5.3);
});

test('processCaptionEvents detects pauses even with rolling ASR durations and caps at 12 words', () => {
  const events = [
    // Rolling dDurationMs = 5000ms for 3 words -> estimated spoken end ~1210ms; next at 1800ms -> gap > 450ms
    { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'First short phrase' }] },
    { tStartMs: 1800, dDurationMs: 1000, segs: [{ utf8: 'one two three four five six seven' }] },
    { tStartMs: 2800, dDurationMs: 1000, segs: [{ utf8: 'eight nine ten eleven twelve thirteen' }] },
  ];

  const cues = processCaptionEvents(events);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].text, 'First short phrase');
  assert.equal(cues[1].text, 'one two three four five six seven');
  assert.equal(cues[2].text, 'eight nine ten eleven twelve thirteen');
});

test('processCaptionEvents skips pure [Music] events and clamps overlapping windows', () => {
  const events = [
    { tStartMs: 500, dDurationMs: 3000, segs: [{ utf8: '[Music]' }] },
    { tStartMs: 1000, dDurationMs: 5000, segs: [{ utf8: 'Hello world from get hub.' }] },
    { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'Second sentence starts early.' }] },
  ];

  const cues = processCaptionEvents(events);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello world from GitHub.');
  assert.equal(cues[0].startSec, 1);
  assert.ok(cues[0].endSec <= 3 && cues[0].endSec >= 2.5);
  assert.ok(cues[0].durationSec <= 2 && cues[0].durationSec >= 1.5);
});
