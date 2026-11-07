#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define VDS1022_CHANNELS 2
#define VDS1022_RANGES 10
#define VDS1022_FRAME_SIZE 5211
#define VDS1022_FRAMES_SIZE (VDS1022_CHANNELS * VDS1022_FRAME_SIZE)
#define VDS1022_ALL_CHANNELS 0x03

typedef struct {
    uint16_t gain[VDS1022_CHANNELS][VDS1022_RANGES];
    uint16_t amplitude[VDS1022_CHANNELS][VDS1022_RANGES];
    uint16_t compensation[VDS1022_CHANNELS][VDS1022_RANGES];
    char version[32];
    char serial[32];
    uint16_t phase_fine;
} vds1022_flash_t;

esp_err_t vds1022_check_machine(void);

esp_err_t vds1022_read_flash(vds1022_flash_t *flash);

/** Uploads the bitstream matching the flash version, unless one is already running. */
esp_err_t vds1022_load_fpga(const vds1022_flash_t *flash);

/** Applies the default settings with both channels on, DC coupled, 2 V range, 250 kS/s. */
esp_err_t vds1022_configure(const vds1022_flash_t *flash);

/** Fetches one raw frame per channel of `channel_mask` (bit 0 CH1, bit 1 CH2) into `frames`, back to back. */
esp_err_t vds1022_fetch_frames(uint8_t channel_mask, uint8_t *frames, size_t *count);

/** Writes one register and discards the reply. */
esp_err_t vds1022_send_register(uint32_t address, uint8_t size, uint32_t value);

/** A harmless read that keeps the scope's 3 s watchdog fed. */
esp_err_t vds1022_keepalive(void);

/** True when the acquisition is finished and the trigger fired. */
esp_err_t vds1022_trigger_ready(bool *ready);

/** True when the acquisition is finished, with or without a real trigger. */
esp_err_t vds1022_data_finished(bool *finished);

bool vds1022_is_force_trigger(uint32_t address);

/** The raw flash read at the start of the session, or 0 when no session is prepared. */
size_t vds1022_prepared_flash(const uint8_t **data);

void vds1022_end_session(void);
