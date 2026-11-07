#pragma once

#include "esp_err.h"

/** Answers every DNS query with the access point's address, so phones open the captive portal. */
esp_err_t captive_dns_start(void);
