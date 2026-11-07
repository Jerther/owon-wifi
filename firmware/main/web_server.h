#pragma once

#include "esp_err.h"

/** Starts the HTTP server: pages, status, Wi-Fi settings, logs, firmware update and the frame stream. */
esp_err_t web_server_start(void);
