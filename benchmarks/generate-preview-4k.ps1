# Deterministic 3840x2160 source fixture for the preview compositor benchmark.
# The output stays under the git-ignored public/bench/ directory.
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force public\bench | Out-Null
ffmpeg -hide_banner -loglevel error -y `
  -f lavfi -i "testsrc2=size=3840x2160:rate=30" `
  -t 6 -c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p `
  -movflags +faststart public\bench\preview-4k.mp4
Write-Output "wrote public/bench/preview-4k.mp4"

ffmpeg -hide_banner -loglevel error -y -i public\bench\preview-4k.mp4 -frames:v 1 public\bench\preview-4k.png
ffmpeg -hide_banner -loglevel error -y -i public\bench\preview-4k.mp4 `
  -vf "scale=1280:720" -c:v libx264 -preset ultrafast -crf 26 -pix_fmt yuv420p `
  -movflags +faststart public\bench\preview-4k-proxy.mp4
Write-Output "wrote public/bench/preview-4k.png and public/bench/preview-4k-proxy.mp4"
