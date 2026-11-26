import { expect, test } from 'bun:test';
import { assDialogueWithText, assEventSpans, assScriptWithEdits, readAssCues, readAssCueStyle } from '../src/ass-subtitles';

const script = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1280', 'PlayResY: 720',
  '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 4,0:00:01.50,0:00:03.10,Signs,,0,0,0,,{\\pos(24,50)\\c&H2222FF&}Hello, world\\NSecond line',
  'Dialogue: 0,0:00:02.00,0:00:04.00,Vector,,0,0,0,,{\\p1}m 0 0 l 49 49',
].join('\n');

test('ASS cue text is editable while vector and inline styling remain in the source script', () => {
  const cues = readAssCues(script);
  expect(cues).toEqual([{ start: 1.5, end: 3.1, text: 'Hello, world\nSecond line', assLine: 6 }]);
  expect(assEventSpans(script)).toEqual([{ start: 1.5, end: 3.1 }, { start: 2, end: 4 }]);
  const file = new Blob();
  expect(assScriptWithEdits({ file, script, cues })).toBe(script);
  const edited = assScriptWithEdits({ file, script, cues: [{ ...cues[0], text: 'First\nNew, text' }] });
  expect(edited).toContain('{\\pos(24,50)\\c&H2222FF&}First\\NNew, text');
  expect(edited).toContain('{\\p1}m 0 0 l 49 49');
});

test('cue-local style edits retain native ASS values, overrides and the other cues', () => {
  const source = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, Outline, BackColour',
    'Style: Signs,Original Font,24,&H7F332211,3.5,&H80000000',
    ...script.split('\n').slice(4),
    'Dialogue: 0,0:00:04.00,0:00:05.00,Signs,,0,0,0,,Another cue',
  ].join('\n');
  const [first, second] = readAssCues(source);
  const appearance = readAssCueStyle(source, first)!;
  expect(appearance.style).toMatchObject({ fontname: 'Original Font', primarycolour: '&H7F332211', outline: '3.5' });
  const edited = assScriptWithEdits({
    file: new Blob(), script: source,
    cues: [{ ...first, assEdits: { style: { fontsize: '52' }, event: { marginl: '12' } } }, second],
  });
  expect(edited).toContain('Style: LocalscribeCue5,Original Font,52,&H7F332211,3.5,&H80000000');
  expect(edited).toContain('LocalscribeCue5,,12,0,0,,{\\pos(24,50)\\c&H2222FF&}');
  expect(edited).toContain('Signs,,0,0,0,,Another cue');
  expect(edited).toContain('{\\p1}m 0 0 l 49 49');
  expect(assEventSpans(edited)).toEqual(assEventSpans(source));
});

test('editing or pasting text preserves inline changes and vector blocks', () => {
  const styled = '{\\pos(50,40)}abc{\\i1}def{\\i0\\p1}m 0 0 l 10 10{\\p0}ghi';
  expect(assDialogueWithText(styled, '123456789')).toBe(
    '{\\pos(50,40)}123{\\i1}456{\\i0\\p1}m 0 0 l 10 10{\\p0}789',
  );
  expect(assDialogueWithText(styled, 'abcdefghi')).toBe(styled);
});
