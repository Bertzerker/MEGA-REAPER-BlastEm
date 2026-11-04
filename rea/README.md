# MEGA REAPER - BlastEm

A local GPL-3.0-or-later modification of [ulalume/blastem](https://github.com/ulalume/blastem), based on commit `5702187402276e7f0aea2ad4e6784ffb187c8c10`. Retain `COPYING` and `COPYING.fork` when distributing. No cloud service, model key or ROM upload is involved. The upstream debugger, GDB remote, save states and scripted input remain available.

## Run

For the portable Windows release, extract the entire ZIP and run `MEGA REAPER.exe`. It includes the required Node.js runtime, locked production dependency and native DLL. The native launcher selects a local ROM, shows the inspector URL and owns both child processes in a Windows job: normal close and abnormal launcher termination cannot leave its children running. No other browser is opened automatically. See the package's `README.txt`.

From the `blastem` directory:

```powershell
./rea/Start-REA.ps1 -Rom 'C:/path/to/game.md'
```

The launcher uses `blastem-raster.exe`, captures every emulated frame, and prints the inspector URL (default `http://127.0.0.1:8765`). Open it in the Codex in-app browser. The default browser-only mode keeps the actual VDP framebuffer in host RAM and avoids a second native GPU upload/present. Its hidden SDL window does not enter fullscreen or capture the mouse; audio timing and scripted input/control polling remain active. Add `-NativeWindow` for the separate interactive game window with native keyboard/gamepad controls. The browser inspector itself remains read-only. Ctrl+C closes the launcher-owned emulator as well as its server. Occupied ports and an already-running BlastEm process are rejected before launching another instance.

The Node server listens for the native binary producer on the next loopback port (8766). Both ports must be free. Use `-Port 8895` to use 8895/8896 instead. Install the one Node dependency first with `npm ci --prefix rea` if this is a fresh checkout. For a manual launch, `BLASTEM_REA_BROWSER_ONLY=1` enables browser-only presentation when native REA streaming is enabled.

All six views are packed into **one atlas image in one browser canvas**: composite, sprite input, Plane A input, Plane B input, Window input and source/priority map. Captions and hit-testing identify the regions. The isolated images come directly from the VDP compositor and its output-color stage; they are not rebuilt from end-of-frame VRAM. The source map visualizes captured winner/priority/intensity flags. The optional VRAM tile preview and SAT bounds remain separately labeled memory-snapshot diagnostics, not captured raster layers or game hitboxes.

An isolated panel means the actual pre-priority input at that screen position, before other layers occlude it, colored with the scene's captured output intensity. Window and A use the same hardware input lane: A is transparent where Window was selected, rather than inventing A pixels that were not fetched. Shadow/highlight sprite operators are retained as raw control samples and displayed transparently; their resulting intensity is visible in the affected input colors and source metadata. CRAM output artifacts are classified separately in magenta on the source map. Each panel has the same raster extent, including borders. No alternative emulation passes are run.

The graphics target is 60 Hz by default. Native metadata supplies the source cadence (`master_clock / (3420 × region scanlines)`), approximately 59.9227 Hz for NTSC. The presentation clock follows that cadence, capped by the selected refresh limit; it does not consume a 59.92-Hz source at exactly 60 Hz and gradually drain the jitter buffer. Different display/source clocks can require an occasional repeated display refresh; those are not counted as new captures. Select 15/30 Hz to reduce browser work, or set `-CaptureEvery 2` to reduce source capture to half the emulated rate. PAL output remains approximately 50 unique source frames/s. A stopped/paused game, background-tab throttling, a slower display or a slow source cannot provide 60 unique updates/s. The counter measures newly displayed captures, not duplicate redraws.

**Freeze inspection** pauses delivery to that client while emulation continues. Pixel selection, hardware bounds, memory comparisons and JSON export remain available. Memory and register text refresh at 10 Hz for readability and carry their own capture labels; all six graphics regions update together for every presented atlas. Presentation starts with six captured frames buffered (about 100 ms at NTSC rate), with a maximum of ten queued frames. Each socket also has a finite message budget. This trades latency for tolerance of short host/worker scheduling pauses; excess queued frames are dropped rather than allowing latency to grow indefinitely.

## Rendering and transport

```text
One emulation instance
  → capture compositor input pixels and resolve their colors at actual DAC slots
  → nonblocking loopback TCP, no per-frame files
  → Node blits captured RGBA planes into one six-view atlas
  → one binary WebSocket message per capture
  → one WebGL texture upload + textured quad in one canvas
```

Native capture contains completed RGB output, the four captured input images and source map, raw input samples, winner/intensity/artifact flags, VRAM, CRAM, VSRAM, VDP registers, 68000 work RAM and Z80 RAM. CPU and VDP cycle counters identify the core's synchronization point. `rea_raster.c` records the actual inputs used by normal and S/H compositing; output-slot hooks in both H40 paths and the H32 path use the live palette. The fixed four planes have specialized writes, with winner/priority computed once per pixel. Inactive/display-disabled output is recorded explicitly. After publication and on state load, every touched row (including gaps between sparse rows) is cleared in all evidence planes. Untouched rows remain zero from allocation/the preceding reset; full 512-row buffers need not be cleared every frame. It performs no observer hardware-port reads. Socket writes remain nonblocking and bounded.

The server packs each atlas once and shares it among connected viewers. The final transport uses lossless RGBA word runs (`rgba-rle-v1`) for the atlas, with raw fallback whenever runs would expand it. Its linear encoder reuses scratch storage; decoding copies literals and fills repeated pixels. It performs no image reconstruction or color quantization. A real 2,198,592-byte atlas encoded to 381,024 bytes in 0.586 ms and decoded in 1.445 ms in the Node benchmark on this workstation. The complete packet also carries raw evidence/memory buffers, so its reduction differs from the atlas-only figure. General-purpose WebSocket deflate is disabled: its worker backlog could not keep up on the densest scenes. The native TCP leg remains uncompressed.

Each client may have at most six complete messages writing. Message completion callbacks release queue slots; variable header byte counts cannot cause false one-frame overflow. The atlas and all pixel evidence stay bound to one capture ID. Restart the server and reload the viewer after a protocol update.

The server does not use the VRAM decoder for captured panels. Duplicate captured RGBA is omitted from WebSocket payloads because it is already present in the atlas; raw samples and flags still travel alongside it. The browser uses one persistent WebGL texture with nearest-neighbor sampling and cached shader locations. Optional SAT-snapshot bounds are a GPU overlay. Canvas 2D is a compatibility fallback. Clicking a captured panel returns its captured color, sample, palette index, priority, winner, intensity and output-artifact status. It does not infer a tile address from end-of-frame memory. The collapsed VRAM preview is the only image still decoded from that memory snapshot.

The native protocol is a little-endian u32 packet length followed by the live capture packet. A live packet is a little-endian u32 UTF-8 JSON-header length, a header containing metadata and byte-buffer lengths, then the seven basic buffers in `public/transport.mjs` order. Named extras contain `raster_rgba` (five planar RGBA8888 images), `raster_samples` (four planar input-byte images) and `raster_flags` (one byte per output pixel). Layer order is sprites/A/B/Window/source; samples exclude the source image. WebSocket packets additionally contain atlas metadata and contiguous RGBA bytes. Native packets are bounded to 8 MiB. `protocol.mjs` and `public/transport.mjs` define the formats.

In `raster_flags`, bits 0–2 identify the winning source (0 backdrop, 1 A, 2 Window, 3 B, 4 sprites); bit 3 is winner priority, bits 4/5 shadow/highlight, bit 6 inactive/blank output, and bit 7 a CRAM output artifact. `raster.valid` marks supported capture paths; `raster.complete` and `covered_pixels` expose missing coverage. Source-map alpha zero means no output-slot sample was recorded at that position. Unsupported capture modes show unavailable panels rather than silently reconstructing them.

## Structured inspection API

All HTTP endpoints are GET on the chosen inspector URL. Fetch `/api/snapshot`, retain its `id`, and provide `snapshot=<id>` on subsequent inspection requests. Explicit snapshot reads pin the last 16 requested captures separately from the latest 16 streaming captures, so an AI's evidence does not disappear after a few video frames. Expired IDs return 404. Restarting the server clears this in-memory history.

| Endpoint | Parameters/result |
| --- | --- |
| `/api/snapshot` | Full JSON capture; optional `snapshot`; pins the capture for later inspection |
| `/api/history` | Recent capture IDs/frames |
| `/api/live` | Latest raw binary capture; ETag/304 support for nonstreaming clients |
| `/api/memory` | `space=ram|zram|vram|cram|vsram|regs`, relative byte `start`, `length` (1–4096), optional `snapshot` |
| `/api/diff` | Same range parameters plus `from=<older-id>`, optional `snapshot=<newer-id>` |
| `/api/sprites` | Linked SAT entries; optional `snapshot` |
| `/api/pixel` | `view=composite|sprites|a|b|window|source|tiles`, integer `x`, `y`, optional `snapshot`; `tiles` is explicitly a snapshot diagnostic |
| `/api/metrics` | Source/atlas counters, native frame gaps/bytes, encoded packet size, Node pipeline p95/max, pending messages/codec, unique presentation rate, p95 interval, upload cost, drops, duplicates and underruns |
| `/stream` | WebSocket endpoint: one combined atlas packet per capture |

Offsets accept decimal or `0x` hex. RAM offset zero is bus address `0xFF0000`. Word-backed spaces export big-endian bus byte order. JSON buffers are hex strings; `rgb` is RGB888. Capture IDs include process/session identity and sequence. Captured pixel inspection reports output-time evidence and does not claim an unrecorded pattern-fetch or CPU/DMA provenance chain. Snapshot tile inspection remains explicitly labeled as reconstructed from memory.

The server binds loopback, validates HTTP Host and WebSocket Origin, and exposes no hardware-write or execution-control endpoint. `BLASTEM_REA_STREAM_PORT` selects native streaming. With that unset, `BLASTEM_REA_DIR` retains the older atomic JSON-file exporter for diagnostic/API workflows; it is not the high-rate atlas path. `BLASTEM_REA_CAPTURE_EVERY` is read once at startup (1–60, default 1 for streaming). Unset both capture/stream variables to disable REA.

## Build and validate

`Build-Windows.ps1 -Version 0.1.0` creates the portable ZIP from the built emulator, SDL2 and GLEW development files. It downloads the pinned official Node.js 24.20.0 x64 archive and verifies its pinned SHA-256, installs only locked production dependencies without lifecycle scripts, compiles the Win32 launcher using MinGW in WSL, includes license notices, and writes a source-commit/file-hash manifest plus a ZIP checksum. Add `-BuildEmulator -PythonPath '/mnt/c/path/to/python.exe'` to run the native emulator build too. An existing output directory is never overwritten implicitly. The inherited upstream `v*` release workflow does not package REA; MEGA REAPER release tags use `mega-reaper-v*` instead.

Test an extracted release with `Test-WindowsPackage.ps1 -Archive <zip> -Rom <original-diagnostic.bin>`. Use the original basic H40/H32 diagnostic from `make_test_rom.py`; this checks actual VDP colors/RAM, every winning source pixel, all packaged file hashes, bundled Node with the global runtime removed from PATH, paths with spaces/Unicode, duplicate-launch rejection and child-process cleanup. It refuses to run while another BlastEm instance exists. Native launcher options `--headless --duration-ms <n>` support bounded automation without opening a window.

The local Windows build is cross-compiled using Ubuntu WSL and MinGW. SDL2 2.30.9 and GLEW 2.2.0 development distributions are in `sdl/` and `glew/`; see upstream `.github/workflows/build.yml` for acquisition. GNU make and MinGW are required. Use the user's verified interpreter for CPU/font generation:

```text
make -j4 PORTABLE=1 OS=Windows CPU=x86_64 SDL=sdl2 OBJDIR=obj/windows EXE=-raster.exe OPT="-O2 -flto=4" PYTHON=/mnt/c/path/to/python.exe blastem-raster.exe
```

Copy `sdl/x86_64-w64-mingw32/bin/SDL2.dll` alongside the executable. Run `npm ci --prefix rea`, then `node --test rea/test/*.test.mjs` (loopback access required). Twenty-one tests cover pixel equivalence, captured-raster blitting despite contradictory memory, exact hit-testing after stripping duplicate RGBA, explicit unsupported/uncaptured pixels, binary framing, lossless pixel runs/raw fallback/malformed inputs/scratch reuse, WebSocket delivery, retained evidence, delivery-gap metrics and API bounds. Ten-minute simulated presentation runs at 59.94/60/120/144-Hz display refresh verify the NTSC jitter buffer does not drain through source-clock mismatch; lower refresh caps, PAL cadence and stall/freeze resets are also checked.

Generate the original diagnostic ROM with `& 'C:/path/to/python.exe' rea/make_test_rom.py`. Add `--raster-tests` for a ROM that changes CRAM within one scanline, changes scroll/Window/tile patterns mid-frame, restores memory before capture, exceeds the sprite scanline limit and uses S/H operators. `capture_native.mjs ROM OUTPUT.json` launches an isolated test server and native child without disturbing existing sessions. `verify_raster.mjs OUTPUT.json` asserts those effects and compares every winning source pixel against actual composite RGB (excluding separately classified CRAM artifacts). It passes with 65,535 selected pixels checked. Add `--h32` for the H32 basic diagnostic: the actual 283×240 capture passes basic RGB/RAM assertions and 57,344 selected-source pixel comparisons. No commercial ROM is included.

The native helper test also passes, compiled in WSL with `gcc -std=gnu99 -O2 -I. -Izstd rea_raster.c rea/test/raster_capture_test.c -o rea/test-output/raster-capture-test`. It checks DAC-time color retention, Window ownership, S/H operators, priority, blanking, CRAM artifact markers and sparse/out-of-order row resets.

The opt-in CPU benchmark (`gcc -std=gnu99 -O2 -flto -I. -Izstd rea_raster.c rea/benchmark_raster.c -o rea/test-output/benchmark-raster`) measured the capture emit loop at 0.978 → 0.445 ms/frame for two-pixel slots and 0.871 → 0.358 ms/frame for row batches before/after specialization on this workstation under WSL. Both versions produced the same checksum, 489266768. These are isolated host CPU costs, not end-to-end Windows frame times.

Measure actual browser presentation using:

```text
node rea/measure_stream.mjs http://127.0.0.1:8765 180 rea/test-output/rle-direct-performance.json --assert60 --warmup=10
```

The final direct-raster Elemental Master (USA) run on this workstation passed the sustained NTSC 60-fps acceptance check over 179.58 seconds after warm-up, with one BlastEm instance, browser-only native presentation, normal audio timing, the foreground Codex in-app browser and one WebGL atlas. All six panels shared each unique presented capture:

| Measurement | Result |
| --- | --- |
| Native capture supply / core frame cadence | 59.9247 frames/s |
| Unique browser presentations | 59.9192 updates/s |
| Lowest five-second presentation window | 59.7434 updates/s |
| Highest sampled p95 frame interval | 17.1 ms |
| Highest sampled GPU-upload submission time | 0.8 ms |
| Highest sampled Node pipeline p95 | 6.14 ms |
| Encoded WebSocket packet size range (sampled) | 0.815–1.511 MB |
| Native capture gaps | 0 |
| Browser queue drops | 0 |
| Server backpressure skips / browser empty-buffer ticks | 0 / 0 |
| Duplicate frames counted as updates | 0 |

These are unique capture IDs, not repeated redraws. NTSC's source cadence is 59.922743 Hz; occasional display-refresh repeats from the source/display clock difference do not count as new captures. The acceptance command requires at least 59.7 source/presented updates/s, at least 59.5 in every sampled five-second window, p95 intervals at most 18 ms, and zero native gaps, server skips, browser underruns or drops. Detected server/emulator/viewer restarts invalidate the run. The JSON file retains every sampled counter. The earlier loaded-session result of 55.31 updates/s remains in `raster-performance.json`; the table above is the verified final configuration. The native-window option, background throttling, slower displays, other host loads and other ROMs are outside this sustained measurement. `benchmark.mjs` measures the legacy reconstruction path. Linux continuous runtime and macOS are not validated on this workstation.

## Remaining scope

The tested capture paths are Genesis Mode 5 H40 and H32. Mid-frame palette/tile/scroll/Window changes, sprite scanline limits, masking and S/H are taken from the emulator's actual execution. Interlaced output is captured as a VDP field before host weaving/deinterlacing; interlaced behavior is not independently validated. Mode 4, unusual VDP test-register output and 32X composition are not claimed as supported raster paths. Unsupported or partially sampled frames are marked explicitly. SAT bounds can differ from an earlier raster-time SAT, and tile previews are memory snapshots. Threaded VDP rendering remains excluded because its copy cannot supply coherent CPU RAM. Hardware accuracy is bounded by the underlying emulator: these taps preserve what this core rendered, not a claim of perfect equivalence to every physical VDP revision.

Automatic game-hitbox recovery, CPU/DMA provenance, API-controlled checkpoint replay/tracing and persistent AI annotations remain future work in `SPEC.md`.
