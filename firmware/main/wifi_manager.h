#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define WIFI_SSID_MAX 32
#define WIFI_PASSWORD_MAX 63

typedef struct {
    char ssid[WIFI_SSID_MAX + 1];
    bool connected;
    char ip[16];
    uint8_t last_failure;
} wifi_status_t;

typedef struct {
    char ssid[WIFI_SSID_MAX + 1];
    int8_t rssi;
    bool secure;
} wifi_network_t;

esp_err_t wifi_manager_start(void);

/** An empty SSID forgets the network and disconnects. */
esp_err_t wifi_manager_set_credentials(const char *ssid, const char *password);

/** Blocks for the duration of the scan, a few seconds. */
esp_err_t wifi_manager_scan(wifi_network_t *networks, size_t capacity, size_t *count);

void wifi_manager_get_status(wifi_status_t *status);

const char *wifi_manager_ap_ssid(void);
