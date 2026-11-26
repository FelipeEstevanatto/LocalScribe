# Generates the deterministic media corpus used by bench-media.html and
# bench-compare.html. Run from the repository root:
#
#   powershell -ExecutionPolicy Bypass -File benchmarks/generate-corpus.ps1
#
# The files are written to public/bench/ (git-ignored) and are deleted before
# a production build, so the benchmark media never ships to the site.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force public\bench | Out-Null

$source10 = 'public\bench\bench-10s.wav'
$source60 = 'public\bench\bench-60s.wav'

& ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=523.25:sample_rate=48000:duration=10" -f lavfi -i "anoisesrc=color=pink:sample_rate=48000:duration=10:amplitude=0.02" -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0,volume=0.35,pan=stereo|c0=c0|c1=c0" -ar 48000 -ac 2 -c:a pcm_s16le $source10
& ffmpeg -y -hide_banner -loglevel error -f lavfi -i "sine=frequency=523.25:sample_rate=48000:duration=60" -f lavfi -i "anoisesrc=color=pink:sample_rate=48000:duration=60:amplitude=0.02" -filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest:normalize=0,volume=0.35,pan=stereo|c0=c0|c1=c0" -ar 48000 -ac 2 -c:a pcm_s16le $source60

foreach ($duration in @('10', '60')) {
  $wav = "public\bench\bench-$($duration)s.wav"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a libmp3lame -q:a 2 "public\bench\bench-$($duration)s.mp3"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a aac -b:a 192k -movflags +faststart "public\bench\bench-$($duration)s.m4a"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a flac "public\bench\bench-$($duration)s.flac"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a libvorbis -q:a 5 "public\bench\bench-$($duration)s.ogg"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a libopus -b:a 96k -f ogg "public\bench\bench-$($duration)s.opus"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a libopus -b:a 96k "public\bench\bench-$($duration)s.webm"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a aac -b:a 192k -f adts "public\bench\bench-$($duration)s.aac"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a pcm_s16be "public\bench\bench-$($duration)s.aiff"
  & ffmpeg -y -hide_banner -loglevel error -i $wav -c:a pcm_s16le -f caf "public\bench\bench-$($duration)s.caf"
}

& ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=blue:s=320x240:r=15:d=10" -i public\bench\bench-10s.wav -shortest -c:v libx264 -preset ultrafast -c:a aac -b:a 128k public\bench\bench-10s.mp4
& ffmpeg -y -hide_banner -loglevel error -i public\bench\bench-10s.mp4 -c:v mpeg4 -c:a libmp3lame public\bench\bench-10s.avi

Get-ChildItem public\bench | Select-Object Name, Length | Format-Table -AutoSize
