#include "control.h"

#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"

#define QUEUE_LENGTH 8
#define COMMAND_HEADER_SIZE 5
#define ACQUISITION_MESSAGE_SIZE 3
#define CHANNEL_MASK_ALL 0x03

static const char *TAG = "control";

// These would protect the calibration, or desynchronize the reply-based protocol.
static const uint32_t DENIED_ADDRESSES[] = {0x01a0, 0x01b0, 0x4000, 0x4001, 0x1000};

static QueueHandle_t s_queue;

static bool is_denied(uint32_t address) {
    bool denied = false;
    for (size_t i = 0; i < sizeof(DENIED_ADDRESSES) / sizeof(DENIED_ADDRESSES[0]); i++) {
        denied = denied || DENIED_ADDRESSES[i] == address;
    }
    return denied;
}

static bool is_valid_size(uint8_t size) {
    return size == 1 || size == 2 || size == 4;
}

static bool command_fits(const uint8_t *data, size_t length, size_t offset) {
    bool fits = false;
    if (offset + COMMAND_HEADER_SIZE <= length) {
        const uint8_t size = data[offset + sizeof(uint32_t)];
        fits = is_valid_size(size) && offset + COMMAND_HEADER_SIZE + size <= length;
    }
    return fits;
}

static bool commands_are_valid(const control_message_t *message) {
    bool valid = true;
    size_t offset = 1;
    while (valid && offset < message->length) {
        valid = command_fits(message->data, message->length, offset);
        if (valid) {
            control_command_t command;
            control_next_command(message, &offset, &command);
            valid = !is_denied(command.address);
        }
    }
    return valid;
}

static bool acquisition_is_valid(const control_message_t *message) {
    return message->length == ACQUISITION_MESSAGE_SIZE && message->data[2] <= ACQUISITION_SINGLE;
}

static bool message_is_valid(const control_message_t *message) {
    bool valid = false;
    if (message->length > 0 && message->data[0] == CONTROL_COMMANDS) {
        valid = commands_are_valid(message);
    } else if (message->length > 0 && message->data[0] == CONTROL_ACQUISITION) {
        valid = acquisition_is_valid(message);
    }
    return valid;
}

void control_next_command(const control_message_t *message, size_t *offset, control_command_t *command) {
    const uint8_t *entry = &message->data[*offset];
    memcpy(&command->address, entry, sizeof(command->address));
    command->size = entry[sizeof(command->address)];
    command->value = 0;
    memcpy(&command->value, &entry[COMMAND_HEADER_SIZE], command->size);
    *offset += COMMAND_HEADER_SIZE + command->size;
}

void control_read_acquisition(const control_message_t *message, acquisition_t *acquisition) {
    acquisition->channel_mask = message->data[1] & CHANNEL_MASK_ALL;
    acquisition->mode = message->data[2];
}

esp_err_t control_submit(const uint8_t *data, size_t length) {
    esp_err_t err = ESP_ERR_INVALID_ARG;
    static control_message_t message;
    if (length > 0 && length <= CONTROL_MAX_MESSAGE) {
        message.length = length;
        memcpy(message.data, data, length);
        if (message_is_valid(&message)) {
            err = xQueueSend(s_queue, &message, 0) == pdTRUE ? ESP_OK : ESP_ERR_NO_MEM;
        }
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Message of %u bytes rejected: %s", (unsigned)length, esp_err_to_name(err));
    }
    return err;
}

bool control_receive(control_message_t *message, uint32_t timeout_ms) {
    return xQueueReceive(s_queue, message, pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void control_flush(void) {
    xQueueReset(s_queue);
}

esp_err_t control_start(void) {
    s_queue = xQueueCreate(QUEUE_LENGTH, sizeof(control_message_t));
    return s_queue != NULL ? ESP_OK : ESP_ERR_NO_MEM;
}
