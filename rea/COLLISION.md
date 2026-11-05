# Elemental Master (USA) player contact

Open **Collision**, enable **Overlay on Composite**, and choose **All views** or **Focus · Composite**. The overlay uses the same capture as the displayed atlas, including when inspection is frozen or a saved frame is open. The **Boxes** filter selects the player, contact objects, or pickups. The pane lists object type, work RAM address, active-screen rectangle, overlap, and evidence level.

`GET /api/collision?snapshot=<capture-id>` reports the same geometry for a retained capture. Omit the query to use the latest capture, or use `?note=<note-id>` to read an archived capture with its snapshot integrity check. The report separates SAT-biased operands, the active-screen viewport in Composite, and the offset that converts operands to Composite pixel coordinates.

## ROM and operands

- The ROM file SHA-1 is `fd47e4f8c2d6cc82860ae281faad50e3dee2d033`. BlastEm can report `0f1983d5470a7a5d451d34c4eb8f871f983dcce9` when it hashes the same words in little-endian order. The profile matches these exact digests.
- At `$001D60`, the 68000 builds the player's **8×16** box. Left is word `$FFA026` plus 8 and top is word `$FFA020` plus 8.
- The loop checks 40 slots from `$FFA700` with a stride of `$80`. Bit 7 of the flags word admits an object. Type is at `+$02`, left at `+$26`, top at `+$20`, width at `+$1C`, and height at `+$1E`. Type 11 goes to pickup handling.
- The signed word comparisons at `$001D8A–$001DAC` reject equal edges. The subtracts on the left and top tests wrap as 16-bit words. The overlay subtracts the coordinate bias of 128 from each axis, then adds the capture's left and top borders in Composite.
- An overlap branches into contact handling at `$001DAE`. Immunity at `$FFA008` and shield at `$FFA004` can prevent health loss. The health word is `$FFF2F8`.

## Replay proof

The input-only Stage 1 movie **Elemental Master · Stage 1 contact proof** finished all 34 rows without desync. Read-only GDB probes captured the registers, object words, conditional branch target and health write during replay. The two matching completed frames are saved under **Comments** in the local checkout's REA library. They can be inspected without running the emulator.

| Movie frame | Game tick | Player bounds (biased) | Type 22 at `$FFA800` (biased) | Observed CPU result |
| --- | --- | --- | --- | --- |
| 9 | 389 | `[244,252) × [258,274)` | `[253,277) × [268,292)` | One pixel apart on X. `BLE` at `$001D8E` jumped to `$001DB2`. Health stayed at 4. |
| 10 | 390 | `[244,252) × [258,274)` | `[251,275) × [269,293)` | One pixel of X overlap. The branch fell through to `$001D90`, the routine reached `$001DAE`, and `$001EC8` changed health from 4 to 3. |

Movie ID `e1e00000-1e60-4000-8000-000000000003`. Verified executable SHA-1 `255f246dead891314a3583b883a740f7dbf76bb3`. Input log SHA-256 `4cd9cb8ab99e774a7bc7ecdd0244a51b87301a1a66f72e6795e18aeffa79c520`. Start checkpoint SHA-256 `21e954d8715765fbb0a4ccfed94171c311e8adb2bf110deae346c83b57f9d6cc`.

Replay verification covers the player and this Stage 1 24×24 type-22 contact geometry. Other objects from the routine are shown as code-derived. Each live box is an interpretation of completed-frame RAM. The CPU can sample the same fields earlier in a frame, and a highlighted overlap alone does not establish a damage event. The profile covers player contact and pickup checks. Weapon, terrain, and separate boss collision routines are outside this profile.
