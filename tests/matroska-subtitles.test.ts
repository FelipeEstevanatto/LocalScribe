import { expect, test } from 'bun:test';
import { readMatroskaFonts, readMatroskaSubtitleTracks } from '../src/matroska-subtitles';

const text = (value: string) => [...new TextEncoder().encode(value)];

function element(id: number[], data: number[]): number[] {
  const size = data.length < 127 ? [0x80 | data.length] : [0x40 | (data.length >> 8), data.length & 0xff];
  return [...id, ...size, ...data];
}

function track(fields: number[][]): number[] {
  return element([0xae], fields.flat());
}

const header = element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], text('matroska')));
const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

test('finds MKV subtitle ordinals and dispositions alongside media and attachments', async () => {
  const tracks = element([0x16, 0x54, 0xae, 0x6b], [
    ...track([element([0x83], [1]), element([0x86], text('V_MPEGH/ISO/HEVC'))]),
    ...track([element([0x83], [2]), element([0x86], text('A_OPUS'))]),
    ...track([
      element([0x83], [17]), element([0x86], text('S_TEXT/ASS')),
      element([0x22, 0xb5, 0x9c], text('eng')), element([0x53, 0x6e], text('Signs & Songs')),
      element([0x88], [0]), element([0x55, 0xaa], [1]),
    ]),
    ...track([
      element([0x83], [0, 17]), element([0x86], text('S_TEXT/ASS')),
      element([0x22, 0xb5, 0x9c], text('eng')), element([0x22, 0xb5, 0x9d], text('en-GB')),
      element([0x53, 0x6e], text('Dialogue')),
    ]),
    ...track([element([0x83], [17]), element([0x86], text('S_HDMV/PGS'))]),
  ]);
  const attachments = new Blob([Uint8Array.of(0x19, 0x41, 0xa4, 0x69, 0x23, 0x00, 0x00), new Uint8Array(0x30000)]);
  const file = new Blob([Uint8Array.from([...header, ...segment]), attachments, Uint8Array.from(tracks)]);
  expect(await readMatroskaSubtitleTracks(file)).toEqual([
    { index: 0, codec: 'ass', language: 'eng', title: 'Signs & Songs', default: false, forced: true },
    { index: 1, codec: 'ass', language: 'en-GB', title: 'Dialogue', default: true, forced: false },
    { index: 2, codec: 'hdmv_pgs_subtitle', language: 'eng', title: null, default: true, forced: false },
  ]);
});

test('distinguishes an empty track list from a file that needs a fallback probe', async () => {
  const videoOnly = element([0x16, 0x54, 0xae, 0x6b], track([
    element([0x83], [1]), element([0x86], text('V_MPEG4/ISO/AVC')),
  ]));
  expect(await readMatroskaSubtitleTracks(new Blob([Uint8Array.from([...header, ...segment, ...videoOnly])]))).toEqual([]);
  expect(await readMatroskaSubtitleTracks(new Blob([Uint8Array.from([...header, ...segment, ...videoOnly.slice(0, -1)])]))).toBeNull();
  expect(await readMatroskaSubtitleTracks(new Blob(['not Matroska']))).toBeNull();
});

test('loads attached fonts while skipping non-font attachments', async () => {
  const font = [0, 1, 0, 0, 29, 7];
  const fileEntry = (name: string, type: string, data: number[]) => element([0x61, 0xa7], [
    ...element([0x46, 0x6e], text(name)),
    ...element([0x46, 0x60], text(type)),
    ...element([0x46, 0x5c], data),
  ]);
  const attachments = element([0x19, 0x41, 0xa4, 0x69], [
    ...fileEntry('cover.png', 'image/png', [1, 2, 3]),
    ...fileEntry('dialogue.OTF', 'application/octet-stream', font),
  ]);
  const file = new Blob([Uint8Array.from([...header, ...segment, ...attachments])]);
  expect(await readMatroskaFonts(file)).toEqual([Uint8Array.from(font)]);
});
