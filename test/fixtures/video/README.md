# Video fixtures

One-second 64×64 test clips for `test/generative-media-video.mjs`, made with
FFmpeg 6.1 from its built-in test sources:

| Files | Video | Audio | Container |
| --- | --- | --- | --- |
| `h264-aac-1.mp4`, `h264-aac-2.mp4` | H.264, 12 fps, 2 B-frames | AAC, 16 kHz mono | MP4, faststart, edit lists |
| `h264-aac-fragmented-1.mp4`, `h264-aac-fragmented-2.mp4` | H.264, 12 fps, 2 B-frames | AAC, 16 kHz mono | Fragmented MP4, no edit lists |
| `h264-aac-48px.mp4` | H.264 at 48×48 | AAC | MP4 (codec setup differs from the others) |
| `vp9-opus-1.mp4`, `vp9-opus-2.mp4` | VP9, 12 fps | Opus, 48 kHz mono | MP4 (royalty-free codecs, playable in Playwright's Chromium) |

```sh
H="-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 12 -bf 2 -c:a aac -b:a 24k -ac 1 -shortest"
ffmpeg -f lavfi -i "testsrc=size=64x64:rate=12:duration=1" -f lavfi -i "sine=frequency=300:sample_rate=16000:duration=1" \
  $H -movflags +faststart -fflags +bitexact -map_metadata -1 h264-aac-1.mp4
ffmpeg -f lavfi -i "testsrc=size=64x64:rate=12:duration=1" -f lavfi -i "sine=frequency=500:sample_rate=16000:duration=1" \
  $H -movflags frag_keyframe+empty_moov+default_base_moof -fflags +bitexact -map_metadata -1 h264-aac-fragmented-1.mp4
ffmpeg -f lavfi -i "testsrc2=size=64x64:rate=12:duration=1" -f lavfi -i "sine=frequency=400:sample_rate=48000:duration=1" \
  -c:v libvpx-vp9 -b:v 60k -g 12 -deadline realtime -cpu-used 8 -c:a libopus -b:a 16k -ac 1 -shortest \
  -fflags +bitexact -map_metadata -1 vp9-opus-1.mp4
ffmpeg -f lavfi -i "testsrc=size=48x48:rate=12:duration=1" -f lavfi -i "sine=frequency=300:sample_rate=16000:duration=1" \
  $H -movflags +faststart -fflags +bitexact -map_metadata -1 h264-aac-48px.mp4
```

The second clip of each pair uses a different tone (600, 1000 and 800 Hz), so its
bytes and bitrate fields differ while the codec setup matches.
