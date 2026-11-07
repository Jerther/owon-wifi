#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define CONTROL_MAX_MESSAGE 512
#define CONTROL_COMMANDS 0x01
#define CONTROL_ACQUISITION 0x02

typedef enum {
    ACQUISITION_STOPPED,
    ACQUISITION_FREE_RUNNING,
    ACQUISITION_TRIGGERED,
    ACQUISITION_SINGLE,
} acquisition_mode_t;

typedef struct {
    uint8_t channel_mask;
    acquisition_mode_t mode;
} acquisition_t;

typedef struct {
    uint32_t address;
    uint8_t size;
    uint32_t value;
} control_command_t;

typedef struct {
    uint16_t length;
    uint8_t data[CONTROL_MAX_MESSAGE];
} control_message_t;

esp_err_t control_start(void);

/** Validates a message from a browser and queues it. Never blocks, so it is safe in an HTTP handler. */
esp_err_t control_submit(const uint8_t *data, size_t length);

/** Waits up to `timeout_ms` for a queued message. */
bool control_receive(control_message_t *message, uint32_t timeout_ms);

void control_flush(void);

/** Reads the command at `offset` of a validated commands message and moves past it. */
void control_next_command(const control_message_t *message, size_t *offset, control_command_t *command);

/** Reads a validated acquisition message. */
void control_read_acquisition(const control_message_t *message, acquisition_t *acquisition);
