#pragma once

#include <stddef.h>
#include "esp_err.h"

#define SCOPE_USB_MAX_WRITE 10240

esp_err_t scope_usb_start(void);

/** Blocks until the scope is plugged in, opened and its interface claimed. */
void scope_usb_wait_for_scope(void);

void scope_usb_close(void);

esp_err_t scope_usb_write(const void *data, size_t length);

esp_err_t scope_usb_read(void *data, size_t capacity, size_t *length);
