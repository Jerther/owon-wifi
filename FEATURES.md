# Features: OWON's Java app vs the web app

Sources: `OWON-VDS1022/doc/manual_en.pdf` (V1.3), `README.md`, `changes.txt` and the class list of `lib/owon-vds-tiny-1.1.5-cf19.jar`. Last checked 2026-11-07.
"Fork" means an addition made by florentbr's fork, not by OWON.

**Already done**: run/stop, single (also in roll mode), force, autoset; channel on/off, volts/div, position, DC/AC coupling, GND (software only), probe ×1/×10/×100; time base from 5 ns/div up (sin(x)/x below 5 µs/div), waveform quality label, roll mode, peak detect; edge trigger (auto/normal, CH1/CH2/EXT, rising/falling, level, position, 50 %), drag arrows for level, trigger position and channel position; measurements Frequency, Vpp, Vmax, Vmin, Vavg, Vrms; V and T cursors on CH1 or CH2; Hann FFT in dBV with peak readout; XY; CSV export; settings kept in the browser; grid brightness and trace width; value labels on the major grid lines, per channel in its colour; wheel and pinch on the screen step the time base.

## Left to do

| Area | Feature | Java app details | Web app now |
|---|---|---|---|
| Acquisition | Average mode | 1 to 128 frames | Missing |
| Acquisition | Run status | Auto, Ready, Trig'd, Scan, Stop | Partial: running, waiting, stopped |
| Acquisition | Noise filter (fork) | Per channel | Missing |
| Trigger | Hold-off | 100 ns to 10 s | Missing |
| Trigger | Alternate trigger | CH1 and CH2 take turns, each with its own settings | Missing |
| Trigger | Pulse width trigger | +/− pulse, condition (<, >, =, ≠) and width | Missing |
| Trigger | Slope trigger | Rising/falling, high and low levels, time condition | Missing |
| Trigger | Video trigger | NTSC, PAL, SECAM; line, field, odd, even, line number | Missing |
| Trigger | Trigger or pass/fail output on the MULTI port | Utility menu | Missing |
| Vertical | Invert channel | | Missing |
| Vertical | Probes ×20, ×50, ×500, ×1000 (fork) | | Missing |
| Vertical | Current probe mode (fork) | V to A | Missing |
| Vertical | Hardware frequency counter | 6 digits, from the frame header | Partial: computed from the samples |
| Horizontal | Zoom window | Two cursors mark an area, shown full screen with its own time base | Missing |
| Horizontal | Memory depth | 1K to 5K | Missing: always 5K |
| Measurements | Choose which to show | Up to 8 per channel out of 20 | Partial: fixed 6 |
| Measurements | Vtop, Vbase, Vamp, overshoot, preshoot | | Missing |
| Measurements | Period, rise time, fall time, +width, −width, +duty, −duty | | Missing |
| Measurements | Delay CH1 → CH2, rising and falling | | Missing |
| Math | CH1+CH2, CH1−CH2, CH1×CH2, CH1÷CH2 | Own trace and volts/div | Missing |
| FFT | Windows | Rectangle, Hamming, Blackman | Partial: Hann only |
| FFT | Vrms scale, zoom, Hz/div, pan | | Partial: dBV, fixed scale |
| FFT | Cursors | Frequency and amplitude | Missing |
| Display | Persistence | 0.5, 1, 2, 5 s, infinite, clear | Missing |
| Display | Dots instead of lines | | Missing |
| Display | Several views at once | Time + FFT + XY | Partial: one at a time |
| Pass/Fail | Mask test | Mask from the live trace with horizontal and vertical tolerance; pass/fail counters, stop on fail, sound, output | Missing |
| Decoding | Protocol decoding: UART, I2C, SPI… | Not in OWON's app; wanted anyway. Two channels only, so I2C (SDA + SCL) and UART fit; SPI needs 3 or 4 lines | Missing |
| Recording | Record frames | Interval, frame count, file size limit | Missing |
| Recording | Playback | Start/end frame, interval, loop, slider | Missing |
| Reference | Reference waveforms | 8 slots, from CH1, CH2 or Math | Missing |
| Files | Export bin, txt, xls | | Missing (CSV only) |
| Files | Open a saved waveform | | Missing |
| Files | Save the screen as an image | png | Missing |
| Utility | Self-calibration | Zero and gain calibration, saved to the scope's flash | Missing. Not needed for now: the calibration in flash (the user ran self-cal once, years ago, so it may be theirs rather than the factory's) is read at start-up and readings check out. If done: separate maintenance page, step-by-step procedure popup, back up the flash first, and a firmware change (the board now refuses flash writes) |
| Utility | Default settings button | | Missing |
| Utility | Keyboard shortcuts | Space, Enter, arrows, T… | Missing |

Not worth doing: print, skins, language choice, LAN setup, SCPI server, 4-channel models.
