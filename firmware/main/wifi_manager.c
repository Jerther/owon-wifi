#include "wifi_manager.h"

#include "wifi_secrets.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "mdns.h"
#include "nvs_flash.h"

#define AP_SSID "OWON-VDS1022"
#define AP_CHANNEL 1
#define AP_MAX_CLIENTS 4
#define AP_IP "192.168.4.1"
#define HOSTNAME "owon-scope"
// A scan disturbs the access point's clients, so never retry faster.
#define RETRY_DELAY_US 60000000

static const char *TAG = "wifi";

static esp_netif_t *s_ap_netif;
static esp_netif_t *s_sta_netif;
static esp_timer_handle_t s_retry_timer;
static volatile bool s_connected;
static char s_ip[16];
static volatile uint8_t s_last_failure;

const char *wifi_manager_ap_ssid(void) {
    return AP_SSID;
}

static esp_err_t init_nvs(void) {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        err = nvs_flash_erase();
        if (err == ESP_OK) {
            err = nvs_flash_init();
        }
    }
    return err;
}

static bool has_stored_ssid(void) {
    wifi_config_t config;
    return esp_wifi_get_config(WIFI_IF_STA, &config) == ESP_OK && config.sta.ssid[0] != '\0';
}

static void retry_connect(void *arg) {
    if (!s_connected && has_stored_ssid()) {
        ESP_LOGI(TAG, "Retrying the station connection");
        esp_wifi_connect();
    }
}

static void on_station_disconnected(const wifi_event_sta_disconnected_t *event) {
    s_connected = false;
    s_ip[0] = '\0';
    ESP_LOGW(TAG, "Station disconnected, reason %d", event->reason);
    if (event->reason != WIFI_REASON_ASSOC_LEAVE) {
        s_last_failure = event->reason;
        esp_timer_stop(s_retry_timer);
        esp_timer_start_once(s_retry_timer, RETRY_DELAY_US);
    }
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    if (id == WIFI_EVENT_STA_DISCONNECTED) {
        on_station_disconnected(data);
    }
}

static void on_got_ip(void *arg, esp_event_base_t base, int32_t id, void *data) {
    const ip_event_got_ip_t *event = data;
    snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&event->ip_info.ip));
    s_connected = true;
    s_last_failure = 0;
    ESP_LOGI(TAG, "Station got IP %s", s_ip);
}

static esp_err_t offer_dns_from_access_point(void) {
    esp_netif_dns_info_t dns = {0};
    uint8_t offer = 1;
    dns.ip.type = ESP_IPADDR_TYPE_V4;
    esp_netif_str_to_ip4(AP_IP, &dns.ip.u_addr.ip4);

    // The DHCP server only accepts option changes while stopped.
    esp_err_t err = esp_netif_dhcps_stop(s_ap_netif);
    if (err == ESP_OK) {
        err = esp_netif_set_dns_info(s_ap_netif, ESP_NETIF_DNS_MAIN, &dns);
    }
    if (err == ESP_OK) {
        err = esp_netif_dhcps_option(s_ap_netif, ESP_NETIF_OP_SET, ESP_NETIF_DOMAIN_NAME_SERVER, &offer, sizeof(offer));
    }
    if (err == ESP_OK) {
        err = esp_netif_dhcps_start(s_ap_netif);
    }
    return err;
}

static esp_err_t init_network_stack(void) {
    esp_err_t err = esp_netif_init();
    if (err == ESP_OK) {
        err = esp_event_loop_create_default();
    }
    if (err == ESP_OK) {
        s_ap_netif = esp_netif_create_default_wifi_ap();
        s_sta_netif = esp_netif_create_default_wifi_sta();
        err = esp_netif_set_hostname(s_sta_netif, HOSTNAME);
    }
    if (err == ESP_OK) {
        err = esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, on_wifi_event, NULL);
    }
    if (err == ESP_OK) {
        err = esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_got_ip, NULL);
    }
    return err;
}

static esp_err_t create_retry_timer(void) {
    const esp_timer_create_args_t args = {.callback = retry_connect, .name = "wifi_retry"};
    return esp_timer_create(&args, &s_retry_timer);
}

static esp_err_t configure_access_point(void) {
    wifi_config_t ap_config = {
        .ap = {
            .ssid_len = strlen(AP_SSID),
            .channel = AP_CHANNEL,
            .authmode = WIFI_AUTH_WPA2_PSK,
            .max_connection = AP_MAX_CLIENTS,
        },
    };
    memcpy(ap_config.ap.ssid, AP_SSID, strlen(AP_SSID));
    memcpy(ap_config.ap.password, AP_PASSWORD, strlen(AP_PASSWORD));
    return esp_wifi_set_config(WIFI_IF_AP, &ap_config);
}

static esp_err_t start_wifi(void) {
    const wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    esp_err_t err = esp_wifi_init(&init_config);
    if (err == ESP_OK) {
        err = esp_wifi_set_mode(WIFI_MODE_APSTA);
    }
    if (err == ESP_OK) {
        err = configure_access_point();
    }
    if (err == ESP_OK) {
        err = esp_wifi_set_ps(WIFI_PS_NONE);
    }
    if (err == ESP_OK) {
        err = esp_wifi_start();
    }
    return err;
}

static void connect_if_configured(void) {
    if (has_stored_ssid()) {
        ESP_LOGI(TAG, "Connecting to the stored network");
        esp_wifi_connect();
    }
}

static esp_err_t start_name_service(void) {
    esp_err_t err = mdns_init();
    if (err == ESP_OK) {
        err = mdns_hostname_set(HOSTNAME);
    }
    if (err == ESP_OK) {
        err = mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    }
    return err;
}

esp_err_t wifi_manager_start(void) {
    esp_err_t err = init_nvs();
    if (err == ESP_OK) {
        err = init_network_stack();
    }
    if (err == ESP_OK) {
        err = create_retry_timer();
    }
    if (err == ESP_OK) {
        err = offer_dns_from_access_point();
    }
    if (err == ESP_OK) {
        err = start_wifi();
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Access point %s started on channel %d", AP_SSID, AP_CHANNEL);
        connect_if_configured();
        // The IP address still works without the friendly name, so this must not stop the boot.
        const esp_err_t name_err = start_name_service();
        if (name_err != ESP_OK) {
            ESP_LOGW(TAG, "No %s.local name: %s", HOSTNAME, esp_err_to_name(name_err));
        }
    }
    return err;
}

static bool credentials_valid(const char *ssid, const char *password) {
    return ssid != NULL && password != NULL && strlen(ssid) <= WIFI_SSID_MAX && strlen(password) <= WIFI_PASSWORD_MAX;
}

esp_err_t wifi_manager_set_credentials(const char *ssid, const char *password) {
    esp_err_t err = credentials_valid(ssid, password) ? ESP_OK : ESP_ERR_INVALID_ARG;
    wifi_config_t config = {0};
    if (err == ESP_OK) {
        memcpy(config.sta.ssid, ssid, strlen(ssid));
        memcpy(config.sta.password, password, strlen(password));
        esp_timer_stop(s_retry_timer);
        esp_wifi_disconnect();
        err = esp_wifi_set_config(WIFI_IF_STA, &config);
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Station network set to \"%s\"", ssid);
        connect_if_configured();
    }
    return err;
}

static void copy_scan_results(const wifi_ap_record_t *records, wifi_network_t *networks, size_t count) {
    for (size_t i = 0; i < count; i++) {
        snprintf(networks[i].ssid, sizeof(networks[i].ssid), "%s", (const char *)records[i].ssid);
        networks[i].rssi = records[i].rssi;
        networks[i].secure = records[i].authmode != WIFI_AUTH_OPEN;
    }
}

esp_err_t wifi_manager_scan(wifi_network_t *networks, size_t capacity, size_t *count) {
    uint16_t found = capacity;
    wifi_ap_record_t *records = calloc(capacity, sizeof(wifi_ap_record_t));
    esp_err_t err = records != NULL ? esp_wifi_scan_start(NULL, true) : ESP_ERR_NO_MEM;
    if (err == ESP_OK) {
        err = esp_wifi_scan_get_ap_records(&found, records);
    }
    if (err == ESP_OK) {
        copy_scan_results(records, networks, found);
        *count = found;
    }
    free(records);
    return err;
}

void wifi_manager_get_status(wifi_status_t *status) {
    wifi_config_t config;
    memset(status, 0, sizeof(*status));
    if (esp_wifi_get_config(WIFI_IF_STA, &config) == ESP_OK) {
        memcpy(status->ssid, config.sta.ssid, WIFI_SSID_MAX);
    }
    status->connected = s_connected;
    memcpy(status->ip, s_ip, sizeof(status->ip));
    status->last_failure = s_last_failure;
}
