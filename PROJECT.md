# OWON VDS1022I — Wi-Fi sidekick

Status as of 2026-11-06: milestones 1 to 3 work on board 1; first web app version running and looks right on a known signal; several controls still to check.

## Goal

Use the scope from any device (Linux, Windows, Android, iPhone) with **zero setup**: no driver, no udev rule, no app.
Just join a Wi-Fi network and open a web page. No Bluetooth. No Raspberry Pi (no OS to maintain; firmware updates are fine).
The box must be powered on its own (5 V brick now, battery later).

## Architecture

```
5 V brick ──► ESP32-S3 (COM port) ──5 V──► scope
                 │  USB host (native port) ◄──► scope
                 │
               Wi-Fi ──► browser (web app served by the ESP32)
```

- **ESP32-S3 = thin bridge**: uploads the FPGA bitstream, reads calibration, runs the keepalive, sends commands, streams raw frames over a binary WebSocket.
- **All features live in the browser** (display, measures, FFT, math, XY, cursors, pass/fail, decoding, recording, export). The firmware stays small; the web app can grow freely.
- **Wi-Fi**: joins the home network if reachable *and* keeps its own password-protected access point (APSTA, same channel), with a captive portal on the access point so the page pops up on connect.
- **Debugging / updates over Wi-Fi**: OTA with automatic rollback, logs streamed to a debug page. Last-resort recovery: UART (pogo fixture or header pads).
- Turn off Wi-Fi power save (latency). Bluetooth not compiled in.

## The scope — what we know

Source: the Python API in [OWON-VDS1022/api/python/vds1022/vds1022.py](OWON-VDS1022/api/python/vds1022/vds1022.py) (cleanest protocol reference; the Java app in `lib/owon-vds-tiny-*.jar` has a few more registers).

### USB (measured with `lsusb -v`)

| Item | Value |
|---|---|
| VID:PID | `5345:1234` |
| Speed | **Full speed, 12 Mbit/s** |
| Endpoints | bulk IN `0x81`, bulk OUT `0x03`, 64-byte packets, interface 0 |
| Descriptors | Malformed: device class 2 (CDC) with no CDC interface, interface class 5 + a stray HID block. This is why Linux binds `usb_serial_simple`. Must be tolerated by the ESP32 host stack — **first thing to test** |
| Power | ≤ 2.5 W, ~400 mA at 5 V ([Elektor spec](https://www.elektor.com/products/owon-vds1022i-2-kanal-usb-oszilloskop-25-mhz), [EEVblog measurement](https://eevblog.com/forum/testgear/owon-vds1022i-quick-teardown-(versus-the-hantek-6022be)/600)). Descriptor claims 50 mA, ignore it |

### Protocol

- **Command**: `[u32 address LE][u8 size][value: 1, 2 or 4 bytes]` → reply 5 bytes `[status char][u32 value]`. Status chars: `D E G S V`. USB timeout used by the Python API: 200 ms.
- Register list: [vds1022.py:184](OWON-VDS1022/api/python/vds1022/vds1022.py:184). Extra registers only in the Java app: `edge_level_ext`, `trg_holdoff_ext` (external trigger), `PF_ADD` (pass/fail), `MULTIFREQ_ADD`, `MEASure_ADD`, `GETDATA2_ADD`, `PREGET_SLOW_ADD`.
- **Startup sequence** ([vds1022.py:1367](OWON-VDS1022/api/python/vds1022/vds1022.py:1367)):
  1. Claim interface 0, send `GET_MACHINE` (0x4001) with `'V'` → 1 = VDS1022.
  2. `READ_FLASH` (0x01b0) → 2002 bytes: calibration (gain/amplitude/compensation × 2 ch × 10 ranges), OEM, version string, serial, phase fine. Layout in the comment at [vds1022.py:143](OWON-VDS1022/api/python/vds1022/vds1022.py:143).
  3. Pick FPGA version from the flash version string ([vds1022.py:1735](OWON-VDS1022/api/python/vds1022/vds1022.py:1735)).
  4. `QUERY_FPGA` (0x0223): 1 = already loaded. Otherwise `LOAD_FPGA` (0x4000) with the file length → returns frame size; send chunks `[u32 index][payload]`, each acknowledged by `S` + index ([vds1022.py:1782](OWON-VDS1022/api/python/vds1022/vds1022.py:1782)). **The FPGA is volatile: reload at every power-up.**
  5. Default settings ([vds1022.py:1444](OWON-VDS1022/api/python/vds1022/vds1022.py:1444)).
- **Keepalive**: send a command at least every 3 s or the scope drops (the API sends `SET_RUNSTOP 1` when idle).
- **Data**: `GET_DATA` (0x1000), arg = `0x04/0x05` per channel (off/on) → either 5 bytes starting with `E` (not ready) or one 5211-byte frame per active channel: `[u8 ch][u32 time_sum][u32 period_num][u16 cursor][100 trigger samples][5100 ADC samples int8]`. Acquisition loop: [vds1022.py:2209](OWON-VDS1022/api/python/vds1022/vds1022.py:2209).
- **Throughput budget**: ~10.4 KB per two-channel refresh; full speed USB gives ~0.8–1 MB/s in practice → roughly 40–90 refreshes/s ceiling.

### FPGA bitstreams ([OWON-VDS1022/fwr/](OWON-VDS1022/fwr/))

| File | FPGA |
|---|---|
| `VDS1022_FPGAV1_V3.9.bin` | Older, probably Xilinx |
| `VDS1022_FPGAV2_V4.1.bin` | Xilinx (bit-reversed sync word) |
| `VDS1022_FPGAV3/4/5_gaoyun.bin` | **Gowin GW1N-9 / GW1NR-9** (IDCODE `0x1100381B`, same chip as Tang Nano 9K), ~220 KB |

Store all of them in the ESP32 flash; pick by the version read from the scope. Long-term idea (optional, large effort): a custom FPGA design with the open-source Gowin toolchain (Apicula + Yosys + nextpnr) for deeper memory. The USB identity is in the scope's MCU, not the FPGA, and cannot be changed without opening the scope.

## Hardware

### Ordered

| Item | Notes |
|---|---|
| 2 × ESP32-S3-DevKitC-1 **N16R8**, no headers (AliExpress, MT Technology) | Dual USB-C clone. No headers needed for this use |
| Plain ABS boxes, 70×45×18 and 80×50×26 mm (one each) | 70×45×18 fits only if the board is ≤ 65 mm long. File two USB-C slots |
| Flat right-angle USB-A male → USB-C male cable, 10 cm ([listing](https://www.aliexpress.com/item/1005012185894486.html)) | Board "USB" port → scope |
| 5 V / 2 A USB-C brick | Already owned or to get; aim for 5.1–5.2 V output |

### Board power plan (dev board option)

Layout and photos match the [YD-ESP32-S3 V1.4 schematic](https://github.com/deepcoder/YD-ESP32-23/blob/main/YD-ESP32-S3-SCH-V1.4.pdf) (CH343P, SS8050 auto-reset). The schematic is for the family, not necessarily this exact clone: the regulator differs, for one.

- **COM port** = right port seen from the front with the module up, next to the CH343P. Power input from the brick, through diode D1 to the 5 V rail. Also available for flashing and logs during development.
- **USB port** = left port from the front (native, GPIO19 = D−, GPIO20 = D+) = USB host to the scope.
- Close the **"USB-OTG" solder bridge** (back of the board, near the USB port, open as delivered). It shorts D2, so the 5 V rail feeds the USB port's VBUS.
- With the bridge closed, **never plug the USB port into a PC**.
- The scope's power passes through D1, so it sees the brick's voltage minus one diode drop. The diodes are SMA parts marked "SJ", rating not identified. Measure the drop with the scope running; if it's too low, feed the 5Vin pin with the IN-OUT bridge closed (shorts D3, no diode between the pin and the rail).
- `RGB` bridge (front, looks open): closes GPIO48 to the WS2812 LED. Optional, useful as a status LED.
- No USB PD / QC on the board: chargers stay at 5 V. The schematic has 5.1 kΩ on the CC lines; if a USB-C to USB-C charger doesn't power the board anyway, use an A-to-C cable.
- Module is labelled "ESP32-S3-N16R8" with a non-Espressif FCC ID (`DA06P-…`): a clone module, but `esptool` confirms the specs on board 1 (MAC `<MAC>`): ESP32-S3 QFN56 rev v0.2, 16 MB quad flash (manufacturer `0x68`, device `0x4018`), embedded 8 MB PSRAM (`AP_3v3`). The second board is not checked yet.
- Factory firmware answers as `303a:4001` and ignores `esptool`. To read or flash through the USB port, enter download mode (hold BOOT, tap RST, release BOOT): it then shows as `303a:1001`, with the MAC as its USB serial number.

### To check now that the parts are here

1. ~~Test the cable's data lines before closing the USB-OTG bridge.~~ Passed on 2026-11-06.
2. ~~Read the real flash and PSRAM size.~~ Done on board 1.
3. ~~Check that the COM port works on the PC before closing the bridge.~~ Passed on 2026-11-06: board 1 shows as `1a86:55d3`, USB serial `<USB serial>`, and `esptool` resets it without touching the buttons.
4. Close the USB-OTG bridge on board 1.
5. Measure the board and the gap between the two USB-C ports → cut the slots. The 70×45×18 box looks like the one that fits.

### Alternative build (bare module, later)

ESP32-S3-WROOM-1 N16R8 module on the existing WROOM-32 adapter boards ("ESP-32S 转接板 V1.1"), flashed with the WROOM-32 pogo fixture.

- Footprint checked against both Espressif datasheets (WROOM-32 v3.8 p.37, S3-WROOM-1 v1.8 p.45): sides identical (14 pads, 1.27 pitch, 7.49 mm from top edge to pin 1); bottom row: the S3's 10 middle pins land on the WROOM-32's 10 pads. **IO3 (pin 15) and IO45 (pin 26) have no pad** — harmless strapping pins.
- On the adapter: WROOM-32 "IO14"/"IO12" positions (left side, last two) = **S3 IO19/IO20 = USB D−/D+**.
- Needs an external 3.3 V regulator (≥ 500 mA), EN RC (10 kΩ to 3.3 V, 1 µF to GND), RESET/IO0 buttons on the existing footprints, TX/RX/EN/IO0 kept reachable for recovery.
- **Never connect IO35, IO36, IO37** on an N16R8 (octal PSRAM).
- Header-to-pad mapping of the adapter still unknown (need a photo of its back or continuity check).

### Later

- INA219 (I2C) on the scope's 5 V line → current, voltage, sag alert in the web app. With the dev board, it needs an external USB-A port (5 V through the INA219, D−/D+ from GPIO19/20) instead of the USB-OTG bridge.
- Battery: 1 × 18650 ≈ 3 h, 2 × 18650 ≈ 6 h at worst-case 3.5 W. Avoid power-bank chips that auto-shut-off at low current.

## Repository

This repository holds `PROJECT.md` and `firmware/`. The firmware embeds the FPGA files from a separate clone of [florentbr/OWON-VDS1022](https://github.com/florentbr/OWON-VDS1022) in `OWON-VDS1022/`, next to `firmware/`, and needs `firmware/main/wifi_secrets.h` (not in git; defines `AP_PASSWORD`). Tests: `node --test firmware/test/*.mjs`.

## Next steps

1. **Firmware milestone 1 (the risky one)** — ESP-IDF, USB host: enumerate the scope despite its odd descriptors, claim interface 0, `GET_MACHINE`, `READ_FLASH`, upload the FPGA, read one frame. Logs over the COM port. Code in [firmware/](firmware/) (ESP-IDF v5.2.5). **Works on board 1 since 2026-11-06**: the scope (flash version `V2.5.0`, FPGA V1, serial `<scope serial>`) enumerates, the FPGA loads in 1.7 s, and CH1 frames arrive. It only reads the scope's flash, never writes it. Frames take about 84 ms, probably mostly the fixed 60 ms wait after a "not ready" reply, to tune in milestone 2.
   - **Power finding**: with one PC port on COM as the only source (USB-OTG bridge closed), the scope drops off USB right after the last FPGA part, twice out of two full uploads, and can then stay stuck until replugged. With the Y cable's second plug on extra power, it works. **A 5 V brick on COM alone, the final setup, also works** (no logs in that setup: an LED blinked once per second, matching the frame log lines). So the PC port was the weak link, not the board's diode. For development with logs on the PC, keep the Y cable's second plug on extra power. The voltage margin at the scope is not measured.
   - With the bridge open, the scope never appeared on the USB port, consistent with the schematic. The bridge is now closed on board 1.
2. Milestone 2 — acquisition loop + keepalive + binary WebSocket stream. **Works on board 1 since 2026-11-06**, for now on an open test access point `OWON-VDS1022` at `http://192.168.4.1/`: both channels at about 28 refreshes/s from the scope at 250 kS/s, shown live in a phone browser with acceptable lag. A slow client only misses frames; it can't stall the scope's keepalive. Browser-to-scope commands (settings) are not done yet.
3. Milestone 3 — Wi-Fi, updates and logs. **Works on board 1 since 2026-11-06** (firmware 0.3.2):
   - Joins the home network ("<home network>", currently `<board address>`) and keeps its own WPA2 network `OWON-VDS1022` at the same time. Page: `/`; settings: `/settings` (status, Wi-Fi scan list, firmware upload, live logs). Without a joined network it retries every 60 s, so its own network is disturbed briefly at that rate.
   - The password of its own network is in `firmware/main/wifi_secrets.h` (not in git; **the firmware won't build without it**). `firmware/wifi_qr.png` is a joining QR code for that password, to regenerate if it changes.
   - Update over Wi-Fi: `curl -X POST --data-binary @build/owon_sidekick.bin http://<ip>/update`. Takes about 7 s; the stream keeps running at about 17 refreshes/s during the upload. Tested, including rollback: a deliberately crashing image rolled back to the previous version on its own. A new image is confirmed after running 30 s.
   - Captive portal: the page pops up by itself when a phone joins the board's network (confirmed on the user's phone).
   - **Known limit**: firmware upload and Wi-Fi settings have no login, so anyone on the home network or on the board's network can use them.
   - The partition table changed for OTA: a board still on an older table needs one serial flash (`esptool write_flash @flash_args` from `build/`).
4. Web app — first version in [firmware/main/](firmware/main/) (`index.html`, `app.js`, `scope_logic.js`), firmware 0.5.1 on board 1, reachable at `http://owon-scope.local/`. Since 0.5.0, the top bit of the frame sequence number marks a single capture. Logic tests: `node --test firmware/test/*.mjs` (95 pass). Runs live on the real scope at 28 refreshes/s. The user checked a known signal on CH1 with Autoset on 2026-11-06: trace and readings looked right.
   - Single is a one-shot button that keeps the selected sweep (Auto or Normal; Once is no longer a sweep choice, and an old saved Once becomes Auto); Run resumes by the sweep. Arrow handles drag trigger level (right), trigger position (top) and channel position (left), rather than whole lines, to avoid accidental grabs on a phone.
   - Has: run/stop, single, force, autoset; per-channel on/off, range, probe, coupling, position; timebase, roll, peak; edge trigger; measurements; cursors; FFT; XY; CSV export; stats.
   - AC and DC confirmed right by the user. GND: the hardware has no ground relay (mode 2 acts like AC, and the vendor app also forces ground in software), so the page draws a flat trace at the ground marker; the input stays connected.
   - **Checked on board 1 with the 5 V / 1 kHz calibration signal (2026-11-07)**: voltage, frequency (also on the non-source channel), probe scaling, single (also in roll mode, which fills the screen before stopping), Force, Normal-mode wait, trigger level and position, drag arrows with a mouse, roll mode, stopped-mode keepalive.
   - Protocol between browser and board: see `firmware/main/control.c` and `stream.c`. The board refuses register writes that could overwrite the scope's flash or desynchronize the protocol.
   - Not done: pass/fail, protocol decoding, math channels, recording, pulse/slope/video trigger, login on upload and settings.

## What's left

2. Check on a real phone: drag feel with a finger, and performance.
3. Fast timebases: the page stops at 5 us/div (100 MS/s, 5000 samples) while the scope is rated to 5 ns/div; a zoom on the capture could reach them.
4. Remaining features from the Java app: pass/fail, protocol decoding, math channels, recording, pulse/slope/video trigger.
5. Login on firmware upload and Wi-Fi settings.
6. Hardware: pick and cut the box, measure the voltage at the scope with the brick, check and prepare board 2. Later: battery, INA219.

Before uploading any firmware: confirm which physical board to use and check its USB serial number on the port (board 1: COM port serial `<USB serial>`, MAC `<MAC>`).
