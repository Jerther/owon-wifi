#include "web_server.h"

#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "firmware_update.h"
#include "log_buffer.h"
#include "stream.h"
#include "vds1022.h"
#include "wifi_manager.h"

#define MAX_SCANNED_NETWORKS 30

#define SEND_TIMEOUT_S 2
#define STACK_SIZE 8192
#define MAX_URI_HANDLERS 16
#define MAX_WIFI_BODY 256
#define PORTAL_URL "http://192.168.4.1/"

extern const uint8_t index_html_gz_start[] asm("_binary_index_html_gz_start");
extern const uint8_t index_html_gz_end[] asm("_binary_index_html_gz_end");
extern const uint8_t settings_html_gz_start[] asm("_binary_settings_html_gz_start");
extern const uint8_t settings_html_gz_end[] asm("_binary_settings_html_gz_end");

static const char *TAG = "web";

static esp_err_t send_page(httpd_req_t *request, const uint8_t *start, const uint8_t *end) {
    httpd_resp_set_type(request, "text/html");
    httpd_resp_set_hdr(request, "Content-Encoding", "gzip");
    return httpd_resp_send(request, (const char *)start, end - start);
}

static esp_err_t serve_index(httpd_req_t *request) {
    return send_page(request, index_html_gz_start, index_html_gz_end);
}

static esp_err_t serve_settings(httpd_req_t *request) {
    return send_page(request, settings_html_gz_start, settings_html_gz_end);
}

static esp_err_t serve_flash(httpd_req_t *request) {
    const uint8_t *flash;
    const size_t size = vds1022_prepared_flash(&flash);
    esp_err_t err = ESP_OK;
    if (size > 0) {
        httpd_resp_set_type(request, "application/octet-stream");
        err = httpd_resp_send(request, (const char *)flash, size);
    } else {
        httpd_resp_set_status(request, "503 Service Unavailable");
        err = httpd_resp_sendstr(request, "No scope session yet");
    }
    return err;
}

static cJSON *build_status(void) {
    wifi_status_t wifi;
    wifi_manager_get_status(&wifi);
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "version", esp_app_get_description()->version);
    cJSON_AddStringToObject(json, "partition", esp_ota_get_running_partition()->label);
    cJSON_AddStringToObject(json, "ap_ssid", wifi_manager_ap_ssid());
    cJSON_AddStringToObject(json, "sta_ssid", wifi.ssid);
    cJSON_AddBoolToObject(json, "connected", wifi.connected);
    cJSON_AddStringToObject(json, "ip", wifi.ip);
    cJSON_AddNumberToObject(json, "last_failure", wifi.last_failure);
    return json;
}

static esp_err_t serve_status(httpd_req_t *request) {
    esp_err_t err = ESP_ERR_NO_MEM;
    cJSON *json = build_status();
    char *text = cJSON_PrintUnformatted(json);
    if (text != NULL) {
        httpd_resp_set_type(request, "application/json");
        err = httpd_resp_sendstr(request, text);
    }
    free(text);
    cJSON_Delete(json);
    return err;
}

static cJSON *build_networks(const wifi_network_t *networks, size_t count) {
    cJSON *list = cJSON_CreateArray();
    for (size_t i = 0; i < count; i++) {
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "ssid", networks[i].ssid);
        cJSON_AddNumberToObject(item, "rssi", networks[i].rssi);
        cJSON_AddBoolToObject(item, "secure", networks[i].secure);
        cJSON_AddItemToArray(list, item);
    }
    return list;
}

static esp_err_t send_networks(httpd_req_t *request, const wifi_network_t *networks, size_t count) {
    esp_err_t err = ESP_ERR_NO_MEM;
    cJSON *json = build_networks(networks, count);
    char *text = cJSON_PrintUnformatted(json);
    if (text != NULL) {
        httpd_resp_set_type(request, "application/json");
        err = httpd_resp_sendstr(request, text);
    }
    free(text);
    cJSON_Delete(json);
    return err;
}

static esp_err_t serve_networks(httpd_req_t *request) {
    size_t count = 0;
    wifi_network_t *networks = calloc(MAX_SCANNED_NETWORKS, sizeof(wifi_network_t));
    esp_err_t err = networks != NULL ? wifi_manager_scan(networks, MAX_SCANNED_NETWORKS, &count) : ESP_ERR_NO_MEM;
    if (err == ESP_OK) {
        err = send_networks(request, networks, count);
    } else {
        // Scanning is refused while the station is busy connecting; the page offers a retry.
        ESP_LOGW(TAG, "Scan failed: %s", esp_err_to_name(err));
        httpd_resp_set_status(request, "503 Service Unavailable");
        err = httpd_resp_sendstr(request, esp_err_to_name(err));
    }
    free(networks);
    return err;
}

static esp_err_t read_body(httpd_req_t *request, char *body, size_t capacity) {
    esp_err_t err = (request->content_len > 0 && request->content_len < capacity) ? ESP_OK : ESP_ERR_INVALID_SIZE;
    size_t received = 0;
    while (err == ESP_OK && received < request->content_len) {
        const int count = httpd_req_recv(request, &body[received], request->content_len - received);
        if (count > 0) {
            received += (size_t)count;
        } else if (count != HTTPD_SOCK_ERR_TIMEOUT) {
            err = ESP_FAIL;
        }
    }
    if (err == ESP_OK) {
        body[received] = '\0';
    }
    return err;
}

static bool string_within(const cJSON *item, size_t max_length) {
    return cJSON_IsString(item) && strlen(item->valuestring) <= max_length;
}

static esp_err_t apply_wifi_json(const char *body) {
    esp_err_t err = ESP_ERR_INVALID_ARG;
    cJSON *json = cJSON_Parse(body);
    const cJSON *ssid = cJSON_GetObjectItemCaseSensitive(json, "ssid");
    const cJSON *password = cJSON_GetObjectItemCaseSensitive(json, "password");
    if (string_within(ssid, WIFI_SSID_MAX) && string_within(password, WIFI_PASSWORD_MAX)) {
        err = wifi_manager_set_credentials(ssid->valuestring, password->valuestring);
    }
    cJSON_Delete(json);
    return err;
}

static esp_err_t handle_wifi(httpd_req_t *request) {
    char body[MAX_WIFI_BODY + 1];
    esp_err_t err = read_body(request, body, sizeof(body));
    if (err == ESP_OK) {
        err = apply_wifi_json(body);
    }
    if (err == ESP_OK) {
        httpd_resp_sendstr(request, "OK");
    } else if (err == ESP_ERR_INVALID_ARG || err == ESP_ERR_INVALID_SIZE) {
        httpd_resp_send_err(request, HTTPD_400_BAD_REQUEST, "Expected {ssid, password} in at most 256 bytes");
    } else {
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, esp_err_to_name(err));
    }
    return ESP_OK;
}

static esp_err_t serve_logs(httpd_req_t *request) {
    esp_err_t err = ESP_ERR_NO_MEM;
    char *text = heap_caps_malloc(LOG_BUFFER_SIZE, MALLOC_CAP_SPIRAM);
    if (text != NULL) {
        httpd_resp_set_type(request, "text/plain");
        err = httpd_resp_send(request, text, log_buffer_read(text, LOG_BUFFER_SIZE));
    }
    free(text);
    return err;
}

static esp_err_t redirect_to_portal(httpd_req_t *request, httpd_err_code_t code) {
    httpd_resp_set_status(request, "302 Found");
    httpd_resp_set_hdr(request, "Location", PORTAL_URL);
    return httpd_resp_send(request, "Redirecting", HTTPD_RESP_USE_STRLEN);
}

static esp_err_t register_routes(httpd_handle_t server) {
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = serve_index},
        {.uri = "/flash", .method = HTTP_GET, .handler = serve_flash},
        {.uri = "/settings", .method = HTTP_GET, .handler = serve_settings},
        {.uri = "/status", .method = HTTP_GET, .handler = serve_status},
        {.uri = "/wifi", .method = HTTP_POST, .handler = handle_wifi},
        {.uri = "/networks", .method = HTTP_GET, .handler = serve_networks},
        {.uri = "/logs", .method = HTTP_GET, .handler = serve_logs},
        {.uri = "/update", .method = HTTP_POST, .handler = firmware_update_handle},
    };
    esp_err_t err = ESP_OK;
    for (size_t i = 0; err == ESP_OK && i < sizeof(routes) / sizeof(routes[0]); i++) {
        err = httpd_register_uri_handler(server, &routes[i]);
    }
    if (err == ESP_OK) {
        err = stream_register(server);
    }
    if (err == ESP_OK) {
        err = httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, redirect_to_portal);
    }
    return err;
}

esp_err_t web_server_start(void) {
    httpd_handle_t server;
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_open_sockets = STREAM_MAX_SOCKETS;
    config.lru_purge_enable = true;
    config.send_wait_timeout = SEND_TIMEOUT_S;
    config.stack_size = STACK_SIZE;
    config.max_uri_handlers = MAX_URI_HANDLERS;

    esp_err_t err = httpd_start(&server, &config);
    if (err == ESP_OK) {
        err = register_routes(server);
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Web server started");
    }
    return err;
}
