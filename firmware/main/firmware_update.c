#include "firmware_update.h"

#include <stdlib.h>
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"

#define CHUNK_SIZE 4096
#define RESTART_DELAY_US 1000000
#define CONFIRM_DELAY_US 30000000

static const char *TAG = "update";

static void restart(void *arg) {
    esp_restart();
}

static void confirm(void *arg) {
    esp_ota_img_states_t state;
    const esp_partition_t *running = esp_ota_get_running_partition();
    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGI(TAG, "New firmware ran for long enough, cancelling the rollback");
        esp_ota_mark_app_valid_cancel_rollback();
    }
}

static esp_err_t start_one_shot(esp_timer_cb_t callback, const char *name, int64_t delay_us) {
    esp_timer_handle_t timer;
    const esp_timer_create_args_t args = {.callback = callback, .name = name};
    esp_err_t err = esp_timer_create(&args, &timer);
    if (err == ESP_OK) {
        err = esp_timer_start_once(timer, delay_us);
    }
    return err;
}

esp_err_t firmware_update_confirm_later(void) {
    return start_one_shot(confirm, "ota_confirm", CONFIRM_DELAY_US);
}

static esp_err_t receive_chunk(httpd_req_t *request, char *chunk, size_t wanted, size_t *received) {
    esp_err_t err = ESP_OK;
    int count = HTTPD_SOCK_ERR_TIMEOUT;
    while (count == HTTPD_SOCK_ERR_TIMEOUT) {
        count = httpd_req_recv(request, chunk, wanted);
    }
    if (count > 0) {
        *received = (size_t)count;
    } else {
        err = ESP_FAIL;
    }
    return err;
}

static esp_err_t write_body(httpd_req_t *request, esp_ota_handle_t handle) {
    esp_err_t err = ESP_OK;
    char *chunk = malloc(CHUNK_SIZE);
    size_t remaining = request->content_len;
    if (chunk == NULL) {
        err = ESP_ERR_NO_MEM;
    }
    while (err == ESP_OK && remaining > 0) {
        size_t received = 0;
        err = receive_chunk(request, chunk, remaining < CHUNK_SIZE ? remaining : CHUNK_SIZE, &received);
        if (err == ESP_OK) {
            err = esp_ota_write(handle, chunk, received);
            remaining -= received;
        }
    }
    free(chunk);
    return err;
}

static esp_err_t install(httpd_req_t *request, const esp_partition_t *partition) {
    esp_ota_handle_t handle;
    esp_err_t err = request->content_len > 0 ? ESP_OK : ESP_ERR_INVALID_SIZE;
    if (err == ESP_OK) {
        err = esp_ota_begin(partition, OTA_WITH_SEQUENTIAL_WRITES, &handle);
    }
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Receiving %u bytes into %s", (unsigned)request->content_len, partition->label);
        err = write_body(request, handle);
        if (err == ESP_OK) {
            err = esp_ota_end(handle);
        } else {
            esp_ota_abort(handle);
        }
    }
    if (err == ESP_OK) {
        err = esp_ota_set_boot_partition(partition);
    }
    return err;
}

esp_err_t firmware_update_handle(httpd_req_t *request) {
    const esp_partition_t *partition = esp_ota_get_next_update_partition(NULL);
    esp_err_t err = partition != NULL ? install(request, partition) : ESP_ERR_NOT_FOUND;
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Image written, restarting in 1 s");
        httpd_resp_sendstr(request, "OK, restarting");
        start_one_shot(restart, "ota_restart", RESTART_DELAY_US);
    } else {
        ESP_LOGE(TAG, "Update failed: %s", esp_err_to_name(err));
        httpd_resp_send_err(request, HTTPD_500_INTERNAL_SERVER_ERROR, esp_err_to_name(err));
    }
    return ESP_OK;
}
