# Quick tools verification

The browser suite covers the 16 workflows advertised in the [VideoSnap directory](https://videosnap.cc/pt). LocalScribe exports were exercised in Chromium and Firefox with generated inputs. Independent FFprobe/FFmpeg checks read the downloaded containers, dimensions, audio tracks, durations, and transparency.

| Workflow | Verified on the comparison fixtures |
| --- | --- |
| Convert | Downloaded MP4, WebM, MOV, MKV, AVI, M4V, MPEG, and 3GP and identified a video stream in each. |
| Compress | A 12.6 MB source encoded to 931 KB at 720p under a 1 MB target. An eligible MP4 already under budget can be returned without re-encoding. |
| Trim | Exact mode exported the 0.380–1.558 s range within the fixture’s frame and container tolerance. A separate variable-frame-rate clip also passed. |
| Extract audio | Copied AAC from the second audio stream and exported MP3, WAV, FLAC, and OGG. |
| Rotate and flip | Verified quarter-turn dimensions or orientation metadata on the downloaded MP4. |
| Speed | Checked output durations at 2× and 16×. |
| Reverse | Checked output duration at 1× and 2×, and reversed a 90-second fixture in chunks. Cancel and retry preserved the source. |
| Extract frames | Downloaded six PNGs from a three-second range sampled every 0.5 seconds and downloaded the ZIP. |
| Video to GIF | Decoded the exported animation and repeated the export after an offline page reload. |
| Video watermark | Rendered a text overlay and downloaded an MP4. |
| Video collage | Decoded a two-clip MP4 with audio, then independently decoded an alpha WebM with transparent and opaque pixels. |
| Image conversion | Decoded JPEG, PNG, WebP, GIF, and TIFF exports at half the input dimensions. Decoded a TIFF source for PNG export. |
| Image watermark and drawing grid | Downloaded PNG results for both tools. |
| Background cleanup | Checked transparent pixels after color removal, undo and redo, and restoration from an AI cutout opened from Vision Studio. |
| Image collage | Verified a 1280 px PNG canvas and transparency export. |

## VideoSnap spot checks

The same generated 320 × 180, three-second H.264 clip and 160 × 120 reference image were opened in VideoSnap. VideoSnap produced a decodable MP4 from its converter, a 1280 × 720 MP4 from the compressor defaults, a trimmed MP4, and an 80 × 60 JPEG at 50% scale. Those checks establish workflow behavior. Encoding settings, download interactions, and browser caches differed, so the observations do not establish an overall speed or quality ranking.

## Reproducing the core inputs

Use a local FFmpeg installation to create the inputs, then open a production preview with `bun run build` followed by `bun run preview`.

```sh
ffmpeg -f lavfi -i testsrc2=size=320x180:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -f lavfi -i sine=frequency=660:sample_rate=48000 -map 0:v -map 1:a -map 2:a -c:v libx264 -g 25 -c:a aac -t 3 sample.mp4
ffmpeg -f lavfi -i color=c=blue:s=320x180:r=20 -c:v libx264 -t 1.4 short.mp4
ffmpeg -f lavfi -i color=c=white:s=160x120 -vf drawbox=x=48:y=32:w=64:h=56:color=red:t=fill -frames:v 1 color.png
ffprobe -v error -show_streams -show_format -of json result.mp4
```

Use `bun test` to check timestamp parsing, format and route coverage, locale titles, speed filters, and extracted-frame boundaries. For WebM alpha, decode with a decoder that exposes the alpha plane. A black preview or an alpha metadata flag alone is insufficient.

## Known compatibility boundaries

- Direct-to-disk export appears when the browser exposes a file picker and the selected operation can use the shared video export pipeline. Some FFmpeg fallback jobs still construct the output in memory.
- Image conversion uses one still frame of animated input. JPEG flattens transparency to the selected background. GIF output uses a limited palette.
- App descriptions and tool controls are localized. Raw decoder diagnostics may be shown in English.
- Safari, physical low-memory mobile devices, and matched-quality performance across a large sample set are still open verification targets.
