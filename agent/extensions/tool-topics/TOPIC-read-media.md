---
tool: read
name: media
title: Images, SVG and video
when: before reading an image, SVG or video, or asking a question about one
upstream: pi-coding-agent@18.13.2 src/tools/read.ts, src/utils/video.ts, src/utils/image-question.ts, omp://tools/read.md § Images, § Video
---
# Images, SVG and video

- Raster images read directly (no selector): an image-capable model sees the picture; a text-only model gets MIME, size, dimensions and a hint to ask a question instead. Images over 20 MiB are refused.
- `image.png?q=<question>` asks a vision model and returns its answer as text — works for raster images, `file.svg:img`, `attachment://<N>`, `local://` images and PDF page images. Not for text or video.
- SVG reads as text by default; `:img` rasterizes it, `:raw` keeps the original text. `:img` on PNG/JPEG is an error.
- Video (`.mp4 .mov .mkv .webm .m4v .avi .wmv`, needs ffmpeg/ffprobe): bare read gives metadata and a contact sheet; `:412` / `:f412` is one frame by index; `:90s`, `:01:23`, `:1h5m42s`, `:1.5` a frame at a timestamp.
