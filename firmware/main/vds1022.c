#include "vds1022.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "scope_usb.h"

#define MACHINE_VDS1022 1
#define REPLY_SIZE 5
#define STATUS_NOT_READY 'E'
#define STATUS_SUCCESS 'S'
#define COMMAND_ATTEMPTS 3
#define RETRY_DELAY_MS 10

#define FLASH_SIZE 2002
#define FLASH_VERSION 2
#define FLASH_CALIBRATION_OFFSET 6
#define FLASH_STRINGS_OFFSET 207
#define FLASH_LOCALES_SIZE 100

// Polled well below the fastest acquisition time so a ready frame is picked up quickly.
#define FETCH_ATTEMPTS 1000
#define FETCH_RETRY_DELAY_MS 2

#define ADC_SIZE 5100
#define RANGE_2V 5
#define COUPLING_DC 1
#define TIMEBASE_250KSPS 400
#define HOLDOFF_100NS 0x8002
#define EDGE_LEVEL_DISABLED 0x807f
#define FREQ_METER_REFERENCE 20
#define CHANNEL_ON_BIT (1 << 7)
#define COUPLING_SHIFT 5
#define GET_DATA_ON 0x05
#define GET_DATA_OFF 0x04
#define GET_DATA_CHANNEL_SHIFT 8
#define DAC_MAX 4095

typedef struct {
    uint32_t address;
    uint8_t size;
} scope_register_t;

typedef struct {
    scope_register_t reg;
    uint32_t value;
} scope_command_t;

static const scope_register_t REG_READ_FLASH = {0x01b0, 1};
static const scope_register_t REG_QUERY_FPGA = {0x0223, 1};
static const scope_register_t REG_LOAD_FPGA = {0x4000, 4};
static const scope_register_t REG_GET_MACHINE = {0x4001, 1};
static const scope_register_t REG_GET_DATA = {0x1000, 2};
static const scope_register_t REG_TRIGGERED = {0x01, 1};
static const scope_register_t REG_DATA_FINISHED = {0x7a, 1};
static const scope_register_t REG_FORCE_TRIGGER = {0x0c, 1};
static const scope_register_t REG_MULTI = {0x06, 2};
static const scope_register_t REG_PEAK_MODE = {0x09, 1};
static const scope_register_t REG_ROLL_MODE = {0x0a, 1};
static const scope_register_t REG_CHANNELS_ON = {0x0b, 1};
static const scope_register_t REG_PHASE_FINE = {0x18, 2};
static const scope_register_t REG_TRIGGER = {0x24, 2};
static const scope_register_t REG_TIMEBASE = {0x52, 4};
static const scope_register_t REG_POST_TRIGGER = {0x56, 4};
static const scope_register_t REG_PRE_TRIGGER = {0x5a, 2};
static const scope_register_t REG_DEEP_MEMORY = {0x5c, 2};
static const scope_register_t REG_CHANNEL[VDS1022_CHANNELS] = {{0x0111, 1}, {0x0110, 1}};
static const scope_register_t REG_ZERO_OFFSET[VDS1022_CHANNELS] = {{0x010a, 2}, {0x0108, 2}};
static const scope_register_t REG_VOLT_GAIN[VDS1022_CHANNELS] = {{0x0116, 2}, {0x0114, 2}};
static const scope_register_t REG_EDGE_LEVEL[VDS1022_CHANNELS] = {{0x2e, 2}, {0x30, 2}};
static const scope_register_t REG_HOLDOFF[VDS1022_CHANNELS] = {{0x26, 2}, {0x2a, 2}};
static const scope_register_t REG_FREQ_REF[VDS1022_CHANNELS] = {{0x4a, 1}, {0x4b, 1}};

extern const uint8_t fpga_v1_start[] asm("_binary_VDS1022_FPGAV1_V3_9_bin_start");
extern const uint8_t fpga_v1_end[] asm("_binary_VDS1022_FPGAV1_V3_9_bin_end");
extern const uint8_t fpga_v2_start[] asm("_binary_VDS1022_FPGAV2_V4_1_bin_start");
extern const uint8_t fpga_v2_end[] asm("_binary_VDS1022_FPGAV2_V4_1_bin_end");
extern const uint8_t fpga_v3_start[] asm("_binary_VDS1022_FPGAV3_gaoyun_bin_start");
extern const uint8_t fpga_v3_end[] asm("_binary_VDS1022_FPGAV3_gaoyun_bin_end");
extern const uint8_t fpga_v4_start[] asm("_binary_VDS1022_FPGAV4_gaoyun_bin_start");
extern const uint8_t fpga_v4_end[] asm("_binary_VDS1022_FPGAV4_gaoyun_bin_end");
extern const uint8_t fpga_v5_start[] asm("_binary_VDS1022_FPGAV5_gaoyun_bin_start");
extern const uint8_t fpga_v5_end[] asm("_binary_VDS1022_FPGAV5_gaoyun_bin_end");

static const char *TAG = "vds1022";

static uint8_t s_flash[FLASH_SIZE];
static volatile bool s_flash_published;
static uint8_t s_upload[SCOPE_USB_MAX_WRITE];

static esp_err_t write_command(scope_register_t reg, uint32_t value) {
    uint8_t packet[9];
    const uint32_t address = reg.address;
    memcpy(packet, &address, sizeof(address));
    packet[4] = reg.size;
    memcpy(&packet[5], &value, reg.size);
    return scope_usb_write(packet, 5 + reg.size);
}

static esp_err_t read_reply(uint8_t *status, uint32_t *value) {
    uint8_t reply[REPLY_SIZE];
    size_t length;
    esp_err_t err = scope_usb_read(reply, sizeof(reply), &length);
    if (err == ESP_OK && length != REPLY_SIZE) {
        err = ESP_ERR_INVALID_RESPONSE;
    }
    if (err == ESP_OK) {
        *status = reply[0];
        memcpy(value, &reply[1], sizeof(*value));
    }
    return err;
}

static esp_err_t send_command(scope_register_t reg, uint32_t argument, uint32_t *value) {
    esp_err_t err = ESP_FAIL;
    for (int attempt = 0; attempt < COMMAND_ATTEMPTS && err != ESP_OK; attempt++) {
        uint8_t status;
        if (attempt > 0) {
            vTaskDelay(pdMS_TO_TICKS(RETRY_DELAY_MS));
        }
        err = write_command(reg, argument);
        if (err == ESP_OK) {
            err = read_reply(&status, value);
        }
    }
    return err;
}

static esp_err_t send_commands(const scope_command_t *commands, size_t count) {
    esp_err_t err = ESP_OK;
    for (size_t i = 0; i < count && err == ESP_OK; i++) {
        uint32_t ignored;
        err = send_command(commands[i].reg, commands[i].value, &ignored);
    }
    return err;
}

esp_err_t vds1022_check_machine(void) {
    uint32_t machine;
    esp_err_t err = send_command(REG_GET_MACHINE, 'V', &machine);
    if (err == ESP_OK && machine != MACHINE_VDS1022) {
        ESP_LOGE(TAG, "Unsupported machine type %lu", machine);
        err = ESP_ERR_NOT_SUPPORTED;
    }
    return err;
}

static size_t read_string(size_t offset, char *out, size_t capacity) {
    const size_t start = offset < FLASH_SIZE ? offset : FLASH_SIZE - 1;
    const char *text = (const char *)&s_flash[start];
    const size_t length = strnlen(text, FLASH_SIZE - start);
    snprintf(out, capacity, "%.*s", (int)length, text);
    return start + length + 1;
}

static esp_err_t parse_flash(vds1022_flash_t *flash) {
    esp_err_t err = ESP_ERR_INVALID_RESPONSE;
    uint16_t header;
    uint32_t version;
    memcpy(&header, s_flash, sizeof(header));
    memcpy(&version, &s_flash[sizeof(header)], sizeof(version));
    if ((header == 0x55aa || header == 0xaa55) && version == FLASH_VERSION) {
        const uint8_t *calibration = &s_flash[FLASH_CALIBRATION_OFFSET];
        memcpy(flash->gain, calibration, sizeof(flash->gain));
        memcpy(flash->amplitude, calibration + sizeof(flash->gain), sizeof(flash->amplitude));
        memcpy(flash->compensation, calibration + sizeof(flash->gain) + sizeof(flash->amplitude),
               sizeof(flash->compensation));
        size_t offset = read_string(FLASH_STRINGS_OFFSET, flash->version, sizeof(flash->version));
        offset = read_string(offset, flash->serial, sizeof(flash->serial));
        offset += FLASH_LOCALES_SIZE;
        if (offset + sizeof(flash->phase_fine) <= FLASH_SIZE) {
            memcpy(&flash->phase_fine, &s_flash[offset], sizeof(flash->phase_fine));
            err = ESP_OK;
        }
    }
    return err;
}

esp_err_t vds1022_read_flash(vds1022_flash_t *flash) {
    size_t length;
    s_flash_published = false;
    esp_err_t err = write_command(REG_READ_FLASH, 1);
    if (err == ESP_OK) {
        err = scope_usb_read(s_flash, sizeof(s_flash), &length);
    }
    if (err == ESP_OK) {
        err = length == FLASH_SIZE ? parse_flash(flash) : ESP_ERR_INVALID_RESPONSE;
    }
    return err;
}

static bool version_starts_with(const char *version, const char *prefix) {
    return strncasecmp(version, prefix, strlen(prefix)) == 0;
}

static int fpga_version_for(const char *version) {
    int fpga = 0;
    if (version_starts_with(version, "V2.7.0")) {
        fpga = 3;
    } else if (version_starts_with(version, "V2.4.623") || version_starts_with(version, "V2.6.0")) {
        fpga = 2;
    } else if (version_starts_with(version, "V2.") || version_starts_with(version, "V1.")) {
        fpga = 1;
    } else if (version_starts_with(version, "V")) {
        fpga = atoi(&version[1]);
    }
    return fpga;
}

static esp_err_t select_bitstream(int fpga, const uint8_t **start, size_t *size) {
    const uint8_t *const starts[] = {fpga_v1_start, fpga_v2_start, fpga_v3_start, fpga_v4_start, fpga_v5_start};
    const uint8_t *const ends[] = {fpga_v1_end, fpga_v2_end, fpga_v3_end, fpga_v4_end, fpga_v5_end};
    esp_err_t err = ESP_ERR_NOT_SUPPORTED;
    if (fpga >= 1 && fpga <= 5) {
        *start = starts[fpga - 1];
        *size = ends[fpga - 1] - starts[fpga - 1];
        err = ESP_OK;
    }
    return err;
}

static esp_err_t upload_part(uint32_t index, const uint8_t *payload, size_t size) {
    uint8_t status = 0;
    uint32_t acknowledged = 0;
    memcpy(s_upload, &index, sizeof(index));
    memcpy(&s_upload[sizeof(index)], payload, size);
    esp_err_t err = scope_usb_write(s_upload, sizeof(index) + size);
    if (err == ESP_OK) {
        err = read_reply(&status, &acknowledged);
    }
    if (err == ESP_OK && (status != STATUS_SUCCESS || acknowledged != index)) {
        ESP_LOGE(TAG, "Bad acknowledgement for part %lu: '%c' %lu", index, status, acknowledged);
        err = ESP_ERR_INVALID_RESPONSE;
    }
    return err;
}

static esp_err_t upload_bitstream(const uint8_t *bitstream, size_t size) {
    uint32_t frame_size;
    const int64_t started_us = esp_timer_get_time();
    esp_err_t err = send_command(REG_LOAD_FPGA, size, &frame_size);
    if (err == ESP_OK && (frame_size <= sizeof(uint32_t) || frame_size > SCOPE_USB_MAX_WRITE)) {
        ESP_LOGE(TAG, "Unusable FPGA frame size %lu", frame_size);
        err = ESP_ERR_INVALID_RESPONSE;
    }
    if (err == ESP_OK) {
        const size_t payload_size = frame_size - sizeof(uint32_t);
        ESP_LOGI(TAG, "Uploading %u bytes in frames of %lu", size, frame_size);
        size_t sent = 0;
        for (uint32_t index = 0; sent < size && err == ESP_OK; index++) {
            const size_t part = size - sent < payload_size ? size - sent : payload_size;
            err = upload_part(index, &bitstream[sent], part);
            sent += part;
        }
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "FPGA loaded in %lld ms", (esp_timer_get_time() - started_us) / 1000);
    }
    return err;
}

esp_err_t vds1022_load_fpga(const vds1022_flash_t *flash) {
    uint32_t loaded;
    esp_err_t err = send_command(REG_QUERY_FPGA, 0, &loaded);
    if (err == ESP_OK && loaded == 1) {
        ESP_LOGI(TAG, "FPGA already loaded");
    } else if (err == ESP_OK) {
        const int fpga = fpga_version_for(flash->version);
        const uint8_t *bitstream;
        size_t size;
        ESP_LOGI(TAG, "Loading FPGA V%d", fpga);
        err = select_bitstream(fpga, &bitstream, &size);
        if (err == ESP_OK) {
            err = upload_bitstream(bitstream, size);
        }
    }
    return err;
}

static uint32_t clip_to_dac(uint16_t value) {
    return value > DAC_MAX ? DAC_MAX : value;
}

static esp_err_t configure_channel(const vds1022_flash_t *flash, int channel, bool on) {
    const uint32_t state = (COUPLING_DC << COUPLING_SHIFT) | (on ? CHANNEL_ON_BIT : 0);
    const scope_command_t commands[] = {
        {REG_HOLDOFF[channel], HOLDOFF_100NS},
        {REG_EDGE_LEVEL[channel], EDGE_LEVEL_DISABLED},
        {REG_FREQ_REF[channel], FREQ_METER_REFERENCE},
        {REG_ZERO_OFFSET[channel], clip_to_dac(flash->compensation[channel][RANGE_2V])},
        {REG_VOLT_GAIN[channel], clip_to_dac(flash->gain[channel][RANGE_2V])},
        {REG_CHANNEL[channel], state},
    };
    return send_commands(commands, sizeof(commands) / sizeof(commands[0]));
}

esp_err_t vds1022_configure(const vds1022_flash_t *flash) {
    const scope_command_t general[] = {
        {REG_CHANNELS_ON, 0},
        {REG_PHASE_FINE, flash->phase_fine},
        {REG_PEAK_MODE, 0},
        {REG_PRE_TRIGGER, ADC_SIZE},
        {REG_POST_TRIGGER, 0},
        {REG_MULTI, 0},
        {REG_TRIGGER, 0},
    };
    const scope_command_t sampling[] = {
        {REG_TIMEBASE, TIMEBASE_250KSPS},
        {REG_ROLL_MODE, 0},
        {REG_DEEP_MEMORY, ADC_SIZE},
    };
    esp_err_t err = send_commands(general, sizeof(general) / sizeof(general[0]));
    if (err == ESP_OK) {
        err = configure_channel(flash, 0, true);
    }
    if (err == ESP_OK) {
        err = configure_channel(flash, 1, true);
    }
    if (err == ESP_OK) {
        err = send_commands(sampling, sizeof(sampling) / sizeof(sampling[0]));
    }
    s_flash_published = err == ESP_OK;
    return err;
}

static esp_err_t read_frame(uint8_t *frame, size_t *length) {
    esp_err_t err = scope_usb_read(frame, VDS1022_FRAME_SIZE, length);
    if (err == ESP_OK && *length != VDS1022_FRAME_SIZE && *length != REPLY_SIZE) {
        err = ESP_ERR_INVALID_RESPONSE;
    }
    return err;
}

static esp_err_t read_remaining_frames(uint8_t *frames, size_t count) {
    esp_err_t err = ESP_OK;
    for (size_t index = 1; index < count && err == ESP_OK; index++) {
        size_t length;
        err = read_frame(&frames[index * VDS1022_FRAME_SIZE], &length);
        if (err == ESP_OK && length != VDS1022_FRAME_SIZE) {
            err = ESP_ERR_INVALID_RESPONSE;
        }
    }
    return err;
}

static uint32_t get_data_argument(uint8_t channel_mask) {
    uint32_t argument = 0;
    for (int channel = 0; channel < VDS1022_CHANNELS; channel++) {
        const bool on = (channel_mask >> channel) & 1;
        argument |= (uint32_t)(on ? GET_DATA_ON : GET_DATA_OFF) << (channel * GET_DATA_CHANNEL_SHIFT);
    }
    return argument;
}

static esp_err_t read_first_frame(uint32_t argument, uint8_t *frame) {
    esp_err_t err = ESP_ERR_TIMEOUT;
    bool waiting = true;
    for (int attempt = 0; attempt < FETCH_ATTEMPTS && waiting; attempt++) {
        size_t length = 0;
        err = write_command(REG_GET_DATA, argument);
        if (err == ESP_OK) {
            err = read_frame(frame, &length);
        }
        const bool not_ready = err == ESP_OK && length == REPLY_SIZE && frame[0] == STATUS_NOT_READY;
        if (not_ready) {
            err = ESP_ERR_TIMEOUT;
            vTaskDelay(pdMS_TO_TICKS(FETCH_RETRY_DELAY_MS));
        } else {
            waiting = false;
        }
    }
    return err;
}

esp_err_t vds1022_fetch_frames(uint8_t channel_mask, uint8_t *frames, size_t *count) {
    esp_err_t err = ESP_ERR_INVALID_ARG;
    const size_t wanted = __builtin_popcount(channel_mask & VDS1022_ALL_CHANNELS);
    *count = 0;
    if (wanted > 0) {
        err = read_first_frame(get_data_argument(channel_mask), frames);
        if (err == ESP_OK) {
            err = read_remaining_frames(frames, wanted);
        }
        if (err == ESP_OK) {
            *count = wanted;
        }
    }
    return err;
}

esp_err_t vds1022_send_register(uint32_t address, uint8_t size, uint32_t value) {
    const scope_register_t reg = {address, size};
    uint32_t ignored;
    return send_command(reg, value, &ignored);
}

esp_err_t vds1022_keepalive(void) {
    return vds1022_send_register(REG_QUERY_FPGA.address, REG_QUERY_FPGA.size, 0);
}

static esp_err_t read_flag(scope_register_t reg, bool *set) {
    uint32_t value;
    const esp_err_t err = send_command(reg, 0, &value);
    if (err == ESP_OK) {
        *set = value != 0;
    }
    return err;
}

esp_err_t vds1022_trigger_ready(bool *ready) {
    esp_err_t err = read_flag(REG_DATA_FINISHED, ready);
    if (err == ESP_OK && *ready) {
        err = read_flag(REG_TRIGGERED, ready);
    }
    return err;
}

esp_err_t vds1022_data_finished(bool *finished) {
    return read_flag(REG_DATA_FINISHED, finished);
}

bool vds1022_is_force_trigger(uint32_t address) {
    return address == REG_FORCE_TRIGGER.address;
}

size_t vds1022_prepared_flash(const uint8_t **data) {
    *data = s_flash;
    return s_flash_published ? FLASH_SIZE : 0;
}

void vds1022_end_session(void) {
    s_flash_published = false;
}
