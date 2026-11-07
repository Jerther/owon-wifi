// Expected values come from the formulas of vds1022.py, re-run in plain Python
// (calibration tables are the ones of the author's scope).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as logic from '../main/scope_logic.js';

const CALIBRATION = {
  gain: [[1271, 1106, 978, 809, 682, 553, 985, 854, 729, 558], [1257, 1101, 975, 808, 680, 553, 982, 854, 727, 558]],
  amplitude: [[148, 147, 147, 147, 147, 147, 147, 147, 146, 147], [144, 144, 145, 145, 145, 145, 145, 143, 144, 145]],
  compensation: [[517, 521, 522, 523, 523, 523, 522, 522, 522, 523], [500, 507, 510, 512, 513, 513, 510, 510, 511, 513]],
};

function makeFlash({ header = 0x55aa, flashVersion = 2, version = 'V2.5.0', serial = 'VDS1022ITEST', phaseFine = 7 } = {}) {
  const bytes = new Uint8Array(logic.FLASH_SIZE).fill(0xff);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, header, true);
  view.setUint32(2, flashVersion, true);
  const tables = [...CALIBRATION.gain, ...CALIBRATION.amplitude, ...CALIBRATION.compensation];
  tables.forEach((table, t) => table.forEach((value, i) => view.setUint16(6 + t * 20 + i * 2, value, true)));
  bytes[206] = 1;
  const text = `${version}\0${serial}\0`;
  [...text].forEach((character, i) => { bytes[207 + i] = character.charCodeAt(0); });
  const localesEnd = 207 + text.length + 100;
  view.setUint16(localesEnd, phaseFine, true);
  return bytes;
}

function settingsWith(changes = {}) {
  const settings = logic.defaultSettings();
  settings.channels[0] = { on: true, probe: 10, coupling: logic.DC, rangeIndex: 5, offset: 0.1 };
  Object.assign(settings.trigger, changes);
  return settings;
}

function registerValue(writes, address) {
  return writes.find((item) => item.address === address)?.value;
}

function makeMessage(frames, roll = false) {
  const message = new ArrayBuffer(4 + frames.length * logic.FRAME_SIZE);
  const bytes = new Uint8Array(message);
  new DataView(message).setUint32(0, 41, true);
  frames.forEach((frame, index) => {
    const base = 4 + index * logic.FRAME_SIZE;
    const view = new DataView(message, base, logic.FRAME_SIZE);
    view.setUint8(0, frame.channel);
    view.setUint32(1, frame.timeSum, true);
    view.setUint32(5, frame.periodNum, true);
    view.setUint16(9, frame.cursor, true);
    bytes.fill(frame.fill, base + 111, base + logic.FRAME_SIZE);
    bytes[base + 111 + (roll ? 100 : 50)] = 77;
    bytes[base + 111 + (roll ? 100 : 50) + 4999] = 88;
  });
  return message;
}

// ---- python rounding

test('test_given_half_values_when_pyRound_then_goes_to_even', () => {
  const results = [0.5, 1.5, 2.5, -0.5, -1.5, 62.5].map(logic.pyRound);

  assert.deepEqual(results, [0, 2, 2, 0, -2, 62]);
});

test('test_given_other_values_when_pyRound_then_rounds_to_nearest', () => {
  assert.equal(logic.pyRound(2.4), 2);
  assert.equal(logic.pyRound(-2.6), -3);
});

// ---- flash

test('test_given_valid_flash_when_parseFlash_then_reads_calibration', () => {
  const flash = makeFlash();

  const parsed = logic.parseFlash(flash);

  assert.deepEqual(parsed.calibration, CALIBRATION);
});

test('test_given_valid_flash_when_parseFlash_then_reads_version_serial_and_phase', () => {
  const flash = makeFlash({ phaseFine: 9 });

  const parsed = logic.parseFlash(flash);

  assert.deepEqual([parsed.version, parsed.serial, parsed.phaseFine, parsed.fpgaVersion], ['V2.5.0', 'VDS1022ITEST', 9, 1]);
});

test('test_given_swapped_header_when_parseFlash_then_accepted', () => {
  const flash = makeFlash({ header: 0xaa55 });

  assert.notEqual(logic.parseFlash(flash), null);
});

test('test_given_bad_header_when_parseFlash_then_null', () => {
  assert.equal(logic.parseFlash(makeFlash({ header: 0x1234 })), null);
});

test('test_given_bad_flash_version_when_parseFlash_then_null', () => {
  assert.equal(logic.parseFlash(makeFlash({ flashVersion: 3 })), null);
});

test('test_given_truncated_flash_when_parseFlash_then_null', () => {
  assert.equal(logic.parseFlash(makeFlash().slice(0, 100)), null);
});

test('test_given_version_strings_when_fpgaVersionFromFlashVersion_then_follows_python', () => {
  const versions = ['V2.7.0', 'V2.4.623', 'V2.6.0', 'V2.5.0', 'V1.3', 'v3.0.1', 'V4.2', 'X1', 'V'];

  const result = versions.map(logic.fpgaVersionFromFlashVersion);

  assert.deepEqual(result, [3, 2, 2, 1, 1, 3, 4, null, null]);
});

// ---- channel registers

test('test_given_dc_channel_2v_when_buildChannelWrites_then_matches_python', () => {
  const channel = { on: true, probe: 1, coupling: logic.DC, rangeIndex: 5, offset: 0 };

  const writes = logic.buildChannelWrites(0, channel, CALIBRATION);

  assert.deepEqual(writes, [
    { address: 0x010a, size: 2, value: 523 },
    { address: 0x0116, size: 2, value: 553 },
    { address: 0x0111, size: 1, value: 160 },
  ]);
});

test('test_given_ch2_ac_negative_offset_when_buildChannelWrites_then_matches_python', () => {
  const channel = { on: true, probe: 10, coupling: logic.AC, rangeIndex: 8, offset: -0.2 };

  const writes = logic.buildChannelWrites(1, channel, CALIBRATION);

  assert.deepEqual(writes.map((item) => [item.address, item.value]), [[0x0108, 583], [0x0114, 727], [0x0110, 130]]);
});

test('test_given_positive_offset_when_buildChannelWrites_then_attenuates_from_range_index_6', () => {
  const channel = { on: true, probe: 1, coupling: logic.DC, rangeIndex: 7, offset: 0.25 };

  const writes = logic.buildChannelWrites(0, channel, CALIBRATION);

  assert.deepEqual(writes.map((item) => item.value), [430, 854, 162]);
});

test('test_given_gnd_off_channel_when_buildChannelWrites_then_state_has_no_on_bit', () => {
  const channel = { on: false, probe: 1, coupling: logic.GND, rangeIndex: 9, offset: 0.5 };

  const writes = logic.buildChannelWrites(1, channel, CALIBRATION);

  assert.deepEqual(writes.map((item) => item.value), [332, 558, 66]);
});

// ---- sampling

test('test_given_250k_when_samplingFor_then_prescaler_400_without_roll', () => {
  const sampling = logic.samplingFor(logic.SAMPLING_RATES.indexOf(250e3));

  assert.deepEqual(sampling, { prescaler: 400, rate: 250000, roll: false });
});

test('test_given_1250_when_samplingFor_then_roll', () => {
  const sampling = logic.samplingFor(logic.SAMPLING_RATES.indexOf(1250));

  assert.deepEqual(sampling, { prescaler: 80000, rate: 1250, roll: true });
});

test('test_given_2500_when_samplingFor_then_no_roll', () => {
  assert.equal(logic.samplingFor(logic.SAMPLING_RATES.indexOf(2500)).roll, false);
});

test('test_given_extreme_rates_when_samplingFor_then_prescalers_match_python', () => {
  const slowest = logic.samplingFor(0);
  const fastest = logic.samplingFor(logic.SAMPLING_RATES.length - 1);

  assert.deepEqual([slowest.prescaler, fastest.prescaler], [20000000, 1]);
});

test('test_given_roll_rate_when_buildSamplingWrites_then_deep_memory_has_3_extra', () => {
  const settings = { ...settingsWith(), rateIndex: logic.SAMPLING_RATES.indexOf(1250), peak: true };

  const writes = logic.buildSamplingWrites(settings);

  assert.deepEqual(writes, [
    { address: 0x52, size: 4, value: 80000 },
    { address: 0x0a, size: 1, value: 1 },
    { address: 0x5c, size: 2, value: 5103 },
    { address: 0x09, size: 1, value: 1 },
  ]);
});

test('test_given_normal_rate_when_buildSamplingWrites_then_deep_memory_is_adc_size', () => {
  const writes = logic.buildSamplingWrites(settingsWith());

  assert.equal(registerValue(writes, 0x5c), 5100);
});

test('test_given_roll_rate_when_displayedTriggerPosition_then_one', () => {
  const settings = { ...settingsWith(), rateIndex: 0 };

  assert.equal(logic.displayedTriggerPosition(settings), 1);
});

test('test_given_normal_rate_when_displayedTriggerPosition_then_user_position', () => {
  assert.equal(logic.displayedTriggerPosition(settingsWith({ position: 0.3 })), 0.3);
});

test('test_given_range_index_when_timeRangeSeconds_then_5000_samples_duration', () => {
  assert.equal(logic.timeRangeSeconds(logic.SAMPLING_RATES.indexOf(250e3)), 0.02);
});

// ---- trigger registers

test('test_given_ch1_rise_auto_when_buildTriggerWrites_then_matches_python', () => {
  const writes = logic.buildTriggerWrites(settingsWith({ levelDiv: 1.5 }));

  assert.deepEqual(
    [0x5a, 0x56, 0x2e, 0x4a, 0x26, 0x24, 0x06].map((address) => registerValue(writes, address)),
    [2539, 2561, 13374, 57, 0x8002, 0, 0],
  );
});

test('test_given_ch1_normal_sweep_when_buildTriggerWrites_then_sweep_bits_1', () => {
  const writes = logic.buildTriggerWrites(settingsWith({ levelDiv: 1.5, sweep: logic.SWEEP_NORMAL }));

  assert.equal(registerValue(writes, 0x24), 1024);
});

test('test_given_ch2_fall_once_when_buildTriggerWrites_then_matches_python', () => {
  const settings = logic.defaultSettings();
  settings.channels[1] = { on: true, probe: 1, coupling: logic.DC, rangeIndex: 3, offset: -0.1 };
  Object.assign(settings.trigger, { source: logic.CH2, fall: true, levelDiv: -2, position: 0.25, sweep: logic.SWEEP_ONCE });

  const writes = logic.buildTriggerWrites(settings);

  assert.deepEqual(
    [0x5a, 0x56, 0x30, 0x4b, 0x2a, 0x24].map((address) => registerValue(writes, address)),
    [1289, 3811, 46527, 186, 0x8002, 14336],
  );
});

test('test_given_external_source_when_buildTriggerWrites_then_multi_in_and_no_edge_level_for_ext', () => {
  const writes = logic.buildTriggerWrites(settingsWith({ source: logic.EXT, position: 1, sweep: logic.SWEEP_NORMAL }));

  assert.deepEqual(
    [0x06, 0x5a, 0x56, 0x24, 0x26].map((address) => registerValue(writes, address)),
    [2, 5039, 61, 1025, 0x8002],
  );
});

test('test_given_position_zero_when_buildTriggerWrites_then_pre_39_suf_5061', () => {
  const writes = logic.buildTriggerWrites(settingsWith({ position: 0 }));

  assert.deepEqual([registerValue(writes, 0x5a), registerValue(writes, 0x56)], [39, 5061]);
});

test('test_given_ch1_source_when_buildTriggerWrites_then_ch2_level_disabled', () => {
  const writes = logic.buildTriggerWrites(settingsWith());

  assert.equal(registerValue(writes, 0x30), 0x807f);
});

test('test_given_huge_level_when_triggerLevelCounts_then_clipped_to_adc_max', () => {
  assert.equal(logic.triggerLevelCounts(settingsWith({ levelDiv: 5 })), 125);
});

test('test_given_fall_at_top_when_buildTriggerWrites_then_register_value_stays_in_range', () => {
  const writes = logic.buildTriggerWrites(settingsWith({ levelDiv: 5, fall: true }));

  assert.equal(registerValue(writes, 0x2e) & 0xff, 125);
});

test('test_given_force_trigger_when_buildForceTriggerWrites_then_register_0x0c_value_3', () => {
  assert.deepEqual(logic.buildForceTriggerWrites(), [{ address: 0x0c, size: 1, value: 3 }]);
});

test('test_given_all_settings_when_buildAllWrites_then_none_hits_refused_addresses', () => {
  const refused = [0x01a0, 0x01b0, 0x4000, 0x4001, 0x1000];

  const writes = logic.buildAllWrites(settingsWith(), CALIBRATION);

  assert.equal(writes.some((item) => refused.includes(item.address)), false);
});

// ---- wire encoding

test('test_given_two_writes_when_encodeWrites_then_one_message_little_endian', () => {
  const writes = [{ address: 0x0111, size: 1, value: 160 }, { address: 0x52, size: 4, value: 0x01020304 }];

  const messages = logic.encodeWrites(writes);

  assert.deepEqual(
    [...messages[0]],
    [1, 0x11, 0x01, 0, 0, 1, 160, 0x52, 0, 0, 0, 4, 4, 3, 2, 1],
  );
});

test('test_given_size_2_write_when_encodeWrites_then_value_two_bytes_little_endian', () => {
  const messages = logic.encodeWrites([{ address: 0x24, size: 2, value: 0x3412 }]);

  assert.deepEqual([...messages[0]], [1, 0x24, 0, 0, 0, 2, 0x12, 0x34]);
});

test('test_given_many_writes_when_encodeWrites_then_messages_fit_and_keep_order', () => {
  const writes = Array.from({ length: 150 }, (_, i) => ({ address: 0x100 + i, size: 4, value: i }));

  const messages = logic.encodeWrites(writes);

  const addresses = messages.flatMap((message) => {
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    return Array.from({ length: (message.length - 1) / 9 }, (_, k) => view.getUint32(1 + k * 9, true));
  });
  assert.deepEqual(
    [messages.length, messages.every((m) => m.length <= 512), addresses.join()],
    [3, true, writes.map((w) => w.address).join()],
  );
});

test('test_given_no_writes_when_encodeWrites_then_no_message', () => {
  assert.deepEqual(logic.encodeWrites([]), []);
});

test('test_given_mask_and_mode_when_encodeMode_then_three_bytes', () => {
  assert.deepEqual([...logic.encodeMode(3, logic.MODE_SINGLE)], [2, 3, 3]);
});

test('test_given_each_sweep_when_runModeFor_then_free_triggered_single', () => {
  const modes = [0, 1, 2].map((sweep) => logic.runModeFor(settingsWith({ sweep })));

  assert.deepEqual(modes, [1, 2, 3]);
});

test('test_given_channels_when_channelMask_then_bit_per_channel', () => {
  const settings = logic.defaultSettings();
  settings.channels[1].on = true;

  assert.equal(logic.channelMask(settings), 3);
});

// ---- saved settings

test('test_given_nothing_saved_when_restoreSettings_then_defaults', () => {
  assert.deepEqual(logic.restoreSettings(null), logic.defaultSettings());
});

test('test_given_garbage_when_restoreSettings_then_invalid_fields_fall_back', () => {
  const saved = { channels: [{ probe: 7, rangeIndex: 99, offset: 'x' }], rateIndex: -1, trigger: { source: 9, levelDiv: 80 } };

  const restored = logic.restoreSettings(saved);

  assert.deepEqual(
    [restored.channels[0].probe, restored.channels[0].rangeIndex, restored.channels[0].offset, restored.rateIndex, restored.trigger.source, restored.trigger.levelDiv],
    [1, 5, 0, 14, 0, 5],
  );
});

test('test_given_all_channels_off_when_restoreSettings_then_ch1_on', () => {
  const saved = { channels: [{ on: false }, { on: false }] };

  assert.equal(logic.restoreSettings(saved).channels[0].on, true);
});

test('test_given_valid_saved_settings_when_restoreSettings_then_kept', () => {
  const saved = settingsWith({ fall: true, position: 0.2 });

  assert.deepEqual(logic.restoreSettings(saved), saved);
});

// ---- scaling

test('test_given_probe_and_offset_when_sampleScale_then_matches_python_sy_ty', () => {
  const channel = { probe: 10, rangeIndex: 5, offset: 0.1 };

  const { scale, shift } = logic.sampleScale(channel);

  assert.deepEqual([scale, shift], [20 / 250, -2]);
});

test('test_given_channel_when_voltsPerDivision_then_range_over_ten', () => {
  assert.equal(logic.voltsPerDivision({ probe: 10, rangeIndex: 5, offset: 0 }), 2);
});

test('test_given_channel_when_screenToVolts_then_inverse_of_voltsToScreen', () => {
  const channel = { probe: 10, rangeIndex: 3, offset: -0.2 };

  const volts = logic.screenToVolts(logic.voltsToScreen(1.234, channel), channel);

  assert.ok(Math.abs(volts - 1.234) < 1e-9);
});

test('test_given_ground_sample_when_voltsToScreen_then_ground_position_is_half_plus_offset', () => {
  const channel = { probe: 1, rangeIndex: 5, offset: 0.2 };

  assert.ok(Math.abs(logic.voltsToScreen(0, channel) - 0.7) < 1e-12);
});

// ---- frames

test('test_given_message_when_frameCount_then_one_per_5211_bytes', () => {
  assert.deepEqual([4 + 2 * 5211, 4 + 5211, 4].map(logic.frameCount), [2, 1, 0]);
});

test('test_given_message_when_readSequence_then_little_endian_u32', () => {
  assert.equal(logic.readSequence(makeMessage([])), 41);
});

test('test_given_non_roll_frame_when_parseFrameInto_then_skips_50_pre_samples', () => {
  const message = makeMessage([{ channel: 1, timeSum: 10, periodNum: 3, cursor: 5000, fill: 5 }]);
  const slots = [logic.createFrameSlot(), logic.createFrameSlot()];

  const slot = logic.parseFrameInto(message, 0, false, slots);

  assert.deepEqual(
    [slots[1] === slot, slot.channel, slot.timeSum, slot.periodNum, slot.first, slot.samples[0], slot.samples[4999], slot.samples[1]],
    [true, 1, 10, 3, 0, 77, 88, 5],
  );
});

test('test_given_roll_frame_when_parseFrameInto_then_skips_100_pre_samples', () => {
  const message = makeMessage([{ channel: 0, timeSum: 0, periodNum: 0, cursor: 5000, fill: 5 }], true);
  const slot = logic.createFrameSlot();

  logic.parseFrameInto(message, 0, true, [slot, slot]);

  assert.deepEqual([slot.samples[0], slot.samples[4999]], [77, 88]);
});

test('test_given_partial_roll_cursor_when_parseFrameInto_then_first_is_5000_minus_cursor', () => {
  const message = makeMessage([{ channel: 0, timeSum: 0, periodNum: 0, cursor: 1200, fill: 0 }], true);
  const slot = logic.createFrameSlot();

  logic.parseFrameInto(message, 0, true, [slot, slot]);

  assert.equal(slot.first, 3800);
});

test('test_given_cursor_above_5000_when_parseFrameInto_then_clamped_to_full_frame', () => {
  const message = makeMessage([{ channel: 0, timeSum: 0, periodNum: 0, cursor: 5100, fill: 0 }]);
  const slot = logic.createFrameSlot();

  logic.parseFrameInto(message, 0, false, [slot, slot]);

  assert.equal(slot.first, 0);
});

test('test_given_second_frame_when_parseFrameInto_then_reads_its_own_header', () => {
  const frames = [
    { channel: 0, timeSum: 1, periodNum: 1, cursor: 5000, fill: 0 },
    { channel: 1, timeSum: 99, periodNum: 2, cursor: 5000, fill: 0 },
  ];
  const slots = [logic.createFrameSlot(), logic.createFrameSlot()];

  logic.parseFrameInto(makeMessage(frames), 1, false, slots);

  assert.deepEqual([slots[1].timeSum, slots[1].periodNum, slots[0].timeSum], [99, 2, 0]);
});

test('test_given_time_sum_and_periods_when_frequencyHz_then_period_over_sum_times_100M', () => {
  assert.equal(logic.frequencyHz(100000, 100), 100000);
});

test('test_given_zero_time_sum_when_frequencyHz_then_zero', () => {
  assert.equal(logic.frequencyHz(0, 5), 0);
});

// ---- measurements

function slotWith(samples, first = 0) {
  const slot = logic.createFrameSlot();
  samples.forEach((value, i) => { slot.samples[first + i] = value; });
  slot.first = first;
  return slot;
}

test('test_given_samples_when_measure_then_matches_python_frame_stats', () => {
  const channel = { probe: 10, rangeIndex: 5, offset: 0.1 };
  const slot = slotWith([-50, -20, 0, 10, 40, 125, -125, 3], 4992);

  const result = logic.measure(slot, channel);

  const expected = { vmin: -12, vmax: 8, vpp: 20, vavg: -2.17, vrms: 5.776434886675345 };
  Object.keys(expected).forEach((key) => assert.ok(Math.abs(result[key] - expected[key]) < 1e-9, key));
});

test('test_given_out_of_range_samples_when_measure_then_clipped_to_adc_limits', () => {
  const channel = { probe: 1, rangeIndex: 5, offset: 0 };
  const slot = slotWith([-128, 127], 4998);

  const result = logic.measure(slot, channel);

  assert.deepEqual([result.vmin, result.vmax], [-125 * 0.008, 125 * 0.008]);
});

test('test_given_no_valid_sample_when_measure_then_zeros', () => {
  const slot = logic.createFrameSlot();
  slot.first = 5000;

  assert.equal(logic.measure(slot, { probe: 1, rangeIndex: 5, offset: 0 }).vpp, 0);
});

test('test_given_slot_with_frequency_meter_when_measure_then_frequency_from_time_sum', () => {
  const slot = slotWith([0, 1]);
  slot.timeSum = 100000;
  slot.periodNum = 100;

  assert.equal(logic.measure(slot, { probe: 1, rangeIndex: 5, offset: 0 }).frequency, 100000);
});

// ---- formatting

test('test_given_values_when_formatSi_then_prefix_and_three_digits', () => {
  const texts = [
    logic.formatSi(0.0123456, 'V'), logic.formatSi(1500, 'Hz'), logic.formatSi(-2e-6, 's'),
    logic.formatSi(0, 'V'), logic.formatSi(1, 'V'), logic.formatSi(999.9, 'Hz'),
  ];

  assert.deepEqual(texts, ['12.3 mV', '1.5 kHz', '-2 us', '0 V', '1 V', '1 kHz']);
});

// ---- CSV

test('test_given_two_columns_when_buildCsv_then_header_and_aligned_rows', () => {
  const columns = [
    { name: 'CH1', samples: new Int8Array(5000).fill(10), first: 0, scale: 0.1, shift: 1 },
    { name: 'CH2', samples: new Int8Array(5000).fill(-10), first: 4999, scale: 0.1, shift: 0 },
  ];

  const lines = logic.buildCsv(columns, 1000, 0.5).split('\n');

  assert.deepEqual([lines[0], lines[1], lines[5000], lines.length], ['time_s,CH1_V,CH2_V', '-2.5,2,', '2.499,2,-1', 5002]);
});

test('test_given_partial_frame_when_buildCsv_then_rows_start_at_first_valid_sample', () => {
  const columns = [{ name: 'CH1', samples: new Int8Array(5000), first: 4990, scale: 1, shift: 0 }];

  const lines = logic.buildCsv(columns, 1, 1).split('\n');

  assert.equal(lines.length, 10 + 2);
});

// ---- FFT

function spectrumOfSine(cycles, amplitude) {
  const size = 4096;
  const plan = logic.createFft(size);
  const window = logic.hannWindow(size);
  const slot = logic.createFrameSlot();
  const channel = { probe: 1, rangeIndex: 5, offset: 0 };
  const step = logic.sampleScale(channel).scale;
  const trim = (5000 - size) >> 1;
  for (let i = 0; i < size; i++) {
    slot.samples[trim + i] = Math.round((amplitude / step) * Math.sin((2 * Math.PI * cycles * i) / size));
  }
  const db = new Float32Array(size / 2 + 1);
  logic.computeSpectrum(plan, window, slot, channel, { real: new Float64Array(size), imag: new Float64Array(size) }, db);
  return db;
}

test('test_given_sine_on_bin_when_computeSpectrum_then_peak_at_that_bin', () => {
  const db = spectrumOfSine(128, 0.8);

  const peak = db.indexOf(Math.max(...db));

  assert.equal(peak, 128);
});

test('test_given_sine_when_computeSpectrum_then_peak_level_is_amplitude_in_dbv', () => {
  const db = spectrumOfSine(128, 0.8);

  assert.ok(Math.abs(db[128] - 20 * Math.log10(0.8)) < 0.2, String(db[128]));
});

test('test_given_dc_only_when_computeSpectrum_then_energy_in_bin_zero', () => {
  const db = spectrumOfSine(0, 0);

  assert.equal(db.indexOf(Math.max(...db)), 0);
});

test('test_given_counts_when_fftSizeFor_then_power_of_two_capped_at_4096', () => {
  assert.deepEqual([5000, 4096, 4095, 100, 16].map(logic.fftSizeFor), [4096, 4096, 2048, 64, 16]);
});

test('test_given_plan_when_transform_then_matches_naive_dft', () => {
  const size = 16;
  const plan = logic.createFft(size);
  const input = Array.from({ length: size }, (_, i) => Math.sin(i * 0.7) + (i % 3));
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  input.forEach((value, i) => { real[plan.reverse[i]] = value; });

  logic.transform(plan, real, imag);

  const naive = (k) => input.reduce((sum, value, n) => sum + value * Math.cos((2 * Math.PI * k * n) / size), 0);
  assert.ok([0, 1, 5, 8].every((k) => Math.abs(real[k] - naive(k)) < 1e-9));
});

// ---- autoset

test('test_given_period_when_rateIndexForPeriod_then_largest_rate_not_above_three_periods_rate', () => {
  const rates = [1e-3, 2.5e-4, 0.5].map((period) => logic.SAMPLING_RATES[logic.rateIndexForPeriod(period)]);

  assert.deepEqual(rates, [1.25e6, 5e6, 2500]);
});

test('test_given_huge_period_when_rateIndexForPeriod_then_slowest_rate', () => {
  assert.equal(logic.rateIndexForPeriod(1e6), 0);
});

test('test_given_signal_in_range_when_autosetChannel_then_matches_python', () => {
  const result = logic.autosetChannel(5, 0, -40, 30);

  assert.deepEqual([result.rangeIndex, result.level, result.amplitude], [4, -10, 80]);
});

test('test_given_small_range_signal_when_autosetChannel_then_matches_python', () => {
  const result = logic.autosetChannel(2, 0, 0, 90);

  assert.deepEqual([result.rangeIndex, result.level, result.amplitude], [2, 45, 180]);
});

test('test_given_clipped_signal_when_autosetChannel_then_range_jumps_halfway_to_max', () => {
  const result = logic.autosetChannel(5, 0, -125, 30);

  assert.deepEqual([result.rangeIndex, result.level], [7, null]);
});

test('test_given_flat_signal_when_autosetChannel_then_channel_off', () => {
  assert.deepEqual(logic.autosetChannel(5, 0, -5, 5), { off: true });
});

test('test_given_slot_when_frameMinMax_then_only_valid_samples', () => {
  const slot = slotWith([5, -3, 9], 4997);
  slot.samples[0] = 100;

  assert.deepEqual(logic.frameMinMax(slot), { low: -3, high: 9 });
});

test('test_given_ground_coupling_when_forceGround_then_trace_sits_on_ground_and_reads_zero', () => {
  const slot = logic.createFrameSlot();
  const channel = { coupling: logic.GND, offset: 0.2 };
  slot.samples.fill(100);
  slot.timeSum = 1000;
  slot.periodNum = 10;
  logic.forceGround(slot, channel);
  assert.equal(slot.samples[0], 50);
  assert.equal(slot.samples[logic.SAMPLES - 1], 50);
  assert.equal(logic.frequencyHz(slot.timeSum, slot.periodNum), 0);
});

test('test_given_single_when_runModeFor_then_single_whatever_the_sweep', () => {
  const modes = [0, 1, 2].map((sweep) => logic.runModeFor(settingsWith({ sweep }), true));

  assert.deepEqual(modes, [3, 3, 3]);
});

test('test_given_no_single_when_isOneShot_then_only_once_sweep', () => {
  const results = [0, 1, 2].map((sweep) => logic.isOneShot(settingsWith({ sweep }), false));

  assert.deepEqual(results, [false, false, true]);
});

test('test_given_single_when_isOneShot_then_true_for_any_sweep', () => {
  assert.equal(logic.isOneShot(settingsWith({ sweep: logic.SWEEP_NORMAL }), true), true);
});

test('test_given_normal_sweep_and_single_when_buildTriggerWrites_then_once_bits_and_settings_untouched', () => {
  const settings = settingsWith({ sweep: logic.SWEEP_NORMAL });

  const single = logic.buildTriggerWrites(settings, true);
  const resumed = logic.buildTriggerWrites(settings, false);

  assert.equal(registerValue(single, 0x24), 2048);
  assert.equal(registerValue(resumed, 0x24), 1024);
  assert.equal(settings.trigger.sweep, logic.SWEEP_NORMAL);
});

test('test_given_single_when_buildAllWrites_then_trigger_register_has_once_bits', () => {
  const writes = logic.buildAllWrites(settingsWith({ sweep: logic.SWEEP_AUTO }), CALIBRATION, true);

  assert.equal(registerValue(writes, 0x24), 2048);
});

test('test_given_pointer_height_when_offsetAtScreen_then_ground_follows_and_clamps', () => {
  assert.equal(logic.offsetAtScreen(0.5), 0);
  assert.equal(logic.offsetAtScreen(0.3), 0.2);
  assert.equal(logic.offsetAtScreen(-1), 0.45);
  assert.equal(logic.offsetAtScreen(2), -0.45);
});

test('test_given_offset_when_levelDivAtScreen_then_level_is_relative_to_ground_and_clamps', () => {
  assert.equal(logic.levelDivAtScreen(0.5, 0), 0);
  assert.equal(logic.levelDivAtScreen(0.3, 0.1), 1);
  assert.equal(logic.levelDivAtScreen(-2, 0), 5);
  assert.equal(logic.levelDivAtScreen(3, 0), -5);
});

test('test_given_pointer_x_when_positionAtScreen_then_snapped_and_clamped', () => {
  assert.equal(logic.positionAtScreen(0.5049), 0.5);
  assert.equal(logic.positionAtScreen(-0.2), 0);
  assert.equal(logic.positionAtScreen(1.4), 1);
});

test('test_given_saved_once_sweep_when_restoreSettings_then_auto_because_single_is_a_button', () => {
  const saved = logic.defaultSettings();
  saved.trigger.sweep = logic.SWEEP_ONCE;
  assert.equal(logic.restoreSettings(saved).trigger.sweep, logic.SWEEP_AUTO);
});
