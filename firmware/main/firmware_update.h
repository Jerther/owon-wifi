#pragma once

#include "esp_err.h"
#include "esp_http_server.h"

/** `POST /update`: the raw .bin as the body. Restarts into the new firmware on success. */
esp_err_t firmware_update_handle(httpd_req_t *request);

/** Marks a freshly updated app as valid after a delay, so a crash loop in the meantime rolls back. */
esp_err_t firmware_update_confirm_later(void);
