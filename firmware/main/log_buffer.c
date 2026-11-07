#include "log_buffer.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define LINE_SIZE 256
#define ESCAPE 0x1B

static char *s_ring;
static size_t s_head;
static size_t s_stored;
static SemaphoreHandle_t s_lock;
static char s_line[LINE_SIZE];

static void append_byte(char byte) {
    s_ring[s_head] = byte;
    s_head = (s_head + 1) % LOG_BUFFER_SIZE;
    if (s_stored < LOG_BUFFER_SIZE) {
        s_stored++;
    }
}

// Colour codes would show up as garbage in the web page.
static size_t skip_color_code(const char *line, size_t index) {
    while (line[index] != '\0' && line[index] != 'm') {
        index++;
    }
    return line[index] == 'm' ? index + 1 : index;
}

static void append_line(const char *line) {
    size_t index = 0;
    while (line[index] != '\0') {
        if (line[index] == ESCAPE) {
            index = skip_color_code(line, index);
        } else {
            append_byte(line[index]);
            index++;
        }
    }
}

static void remember(const char *format, va_list args) {
    if (!xPortInIsrContext() && xSemaphoreTake(s_lock, 0) == pdTRUE) {
        vsnprintf(s_line, sizeof(s_line), format, args);
        append_line(s_line);
        xSemaphoreGive(s_lock);
    }
}

static int log_hook(const char *format, va_list args) {
    va_list copy;
    va_copy(copy, args);
    const int printed = vprintf(format, args);
    remember(format, copy);
    va_end(copy);
    return printed;
}

size_t log_buffer_read(char *out, size_t capacity) {
    size_t count = 0;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    count = s_stored < capacity ? s_stored : capacity;
    const size_t first = (s_head + LOG_BUFFER_SIZE - s_stored) % LOG_BUFFER_SIZE;
    const size_t skipped = s_stored - count;
    for (size_t i = 0; i < count; i++) {
        out[i] = s_ring[(first + skipped + i) % LOG_BUFFER_SIZE];
    }
    xSemaphoreGive(s_lock);
    return count;
}

esp_err_t log_buffer_start(void) {
    esp_err_t err = ESP_ERR_NO_MEM;
    s_ring = heap_caps_malloc(LOG_BUFFER_SIZE, MALLOC_CAP_SPIRAM);
    s_lock = xSemaphoreCreateMutex();
    if (s_ring != NULL && s_lock != NULL) {
        esp_log_set_vprintf(log_hook);
        err = ESP_OK;
    }
    return err;
}
