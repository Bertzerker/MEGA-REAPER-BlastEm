# MEGA REAPER - BlastEm

A Genesis / Mega Drive emulator adapted for AI-assisted reverse engineering, with direct VDP capture and six synchronized inspection views in one browser window.

Built on [ulalume/blastem](https://github.com/ulalume/blastem), base commit `5702187402276e7f0aea2ad4e6784ffb187c8c10`. The original emulator documentation remains in [README](README).

## What it shows

- The actual composite output.
- Sprite, Plane A, Plane B and Window inputs captured from the VDP pipeline.
- A source/priority map showing which input won each pixel.
- Live memory/register inspection, frozen evidence, pixel selection and snapshot export.

All six graphics views come from one emulation pass and travel together as one atlas. Captured colors preserve mid-frame palette, scrolling and Window changes. The isolated views show inputs before other layers hide them. Optional VRAM tiles and SAT bounds are separately labeled snapshot diagnostics; SAT rectangles are not gameplay hitboxes.

## Run on Windows

Build `blastem-raster.exe` and place `SDL2.dll` beside it, following the [build instructions](rea/README.md#build-and-validate). Then run from the repository root:

```powershell
npm ci --prefix rea
./rea/Start-REA.ps1 -Rom 'C:/path/to/game.md'
```

Open **http://127.0.0.1:8765/** in the Codex in-app browser. The default browser-only display avoids a redundant native GPU presentation. Use `-NativeWindow` for a separate native game window with keyboard/gamepad interaction. The browser inspector is read-only. Ctrl+C stops the launcher-owned emulator and inspector. The launcher rejects an already-running BlastEm instance.

No commercial ROMs, local captures, dependency downloads or compiled binaries are included. Supply your own ROM locally.

## Performance and validation

The tested Windows configuration sustained **59.92 unique updates/s** across all six views over three minutes with Elemental Master (USA), with zero native capture gaps, delivery skips, browser drops or underruns. The highest sampled p95 frame interval was **17.1 ms**. This is the Genesis NTSC source rate; the presentation buffer adds about 100 ms of latency.

The implementation uses specialized capture writes, touched-row resets, a persistent nonblocking TCP stream, lossless pixel-run atlas transport and one WebGL canvas. Twenty-one JavaScript tests, native capture tests, and H40/H32 diagnostic ROM checks validate the implementation. See [measurements, supported modes and limitations](rea/README.md).

```powershell
npm test --prefix rea
```

The [specification](rea/SPEC.md) records delivered features and future work, including instruction/DMA provenance, replay control and game-specific collision adapters. Automatic hitbox recovery and a complete AI analysis agent are not implemented.

## License and attribution

Distributed under **GPL-3.0-or-later**; see [COPYING](COPYING). Preserve the upstream notices and [COPYING.fork](COPYING.fork), which covers ulalume's public-domain dedication for that fork's own changes. MEGA REAPER's REA additions remain GPL-3.0-or-later. The bundled Inter typeface retains its [SIL Open Font License](nuklear_ui/Inter-LICENSE.txt).
