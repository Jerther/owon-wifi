#pragma once

#include <stddef.h>
#include "esp_err.h"

#define LOG_BUFFER_SIZE (32 * 1024)

/** Keeps printing to the UART and also remembers the latest log text in PSRAM. */
esp_err_t log_buffer_start(void);

/** Copies the remembered text, oldest first, and returns its length. */
size_t log_buffer_read(char *out, size_t capacity);
