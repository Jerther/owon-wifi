#include "captive_dns.h"
#include "control.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "firmware_update.h"
#include "log_buffer.h"
#include "scope_usb.h"
#include "stream.h"
#include "vds1022.h"
#include "web_server.h"
#include "wifi_manager.h"

#define STATS_PERIOD_US 1000000
// A flash write during an update can stall a transfer past its timeout.
#define MAX_CONSECUTIVE_FAILURES 5
#define IDLE_WAIT_MS 5
#define TRIGGER_WAIT_MS 60
// The scope drops off after about 3 s without a command.
#define KEEPALIVE_PERIOD_US 500000
#define SCOPE_READY_EVENT "{\"event\":\"scope_ready\"}"

static const char *TAG = "main";

typedef struct {
    acquisition_t acquisition;
    int failures;
    uint32_t fetched;
    uint32_t wait_ms;
    int64_t last_command_us;
} session_t;

static uint8_t s_frames[VDS1022_FRAMES_SIZE];
static control_message_t s_message;

static void log_flash(const vds1022_flash_t *flash) {
    ESP_LOGI(TAG, "Scope version=%s serial=%s phase_fine=%u", flash->version, flash->serial, flash->phase_fine);
}

static esp_err_t prepare_scope(void) {
    vds1022_flash_t flash;
    esp_err_t err = vds1022_check_machine();
    if (err == ESP_OK) {
        err = vds1022_read_flash(&flash);
    }
    if (err == ESP_OK) {
        log_flash(&flash);
        err = vds1022_load_fpga(&flash);
    }
    if (err == ESP_OK) {
        err = vds1022_configure(&flash);
    }
    return err;
}

static void log_stats(session_t *session) {
    ESP_LOGI(TAG, "%lu refreshes/s from the scope, %lu sent over Wi-Fi", session->fetched, stream_take_sent_count());
    session->fetched = 0;
}

static bool is_fetching(const acquisition_t *acquisition) {
    return acquisition->channel_mask != 0 && acquisition->mode != ACQUISITION_STOPPED;
}

static bool waits_for_trigger(const acquisition_t *acquisition) {
    return acquisition->mode == ACQUISITION_TRIGGERED || acquisition->mode == ACQUISITION_SINGLE;
}

static esp_err_t record(session_t *session, esp_err_t result, const char *what) {
    esp_err_t err = ESP_OK;
    if (result == ESP_OK) {
        session->failures = 0;
    } else {
        session->failures++;
        ESP_LOGW(TAG, "%s failed (%d/%d): %s", what, session->failures, MAX_CONSECUTIVE_FAILURES,
                 esp_err_to_name(result));
        if (session->failures >= MAX_CONSECUTIVE_FAILURES) {
            err = result;
        }
    }
    return err;
}

static esp_err_t run_commands(const control_message_t *message) {
    esp_err_t err = ESP_OK;
    size_t offset = 1;
    while (err == ESP_OK && offset < message->length) {
        control_command_t command;
        control_next_command(message, &offset, &command);
        err = vds1022_send_register(command.address, command.size, command.value);
    }
    return err;
}

static esp_err_t handle_message(session_t *session, const control_message_t *message) {
    esp_err_t err = ESP_OK;
    if (message->data[0] == CONTROL_COMMANDS) {
        err = run_commands(message);
        session->last_command_us = esp_timer_get_time();
    } else {
        control_read_acquisition(message, &session->acquisition);
    }
    return err;
}

// Waits for the first message, so a pending wait ends as soon as the browser says something.
static esp_err_t handle_messages(session_t *session) {
    esp_err_t err = ESP_OK;
    uint32_t timeout_ms = session->wait_ms;
    while (err == ESP_OK && control_receive(&s_message, timeout_ms)) {
        timeout_ms = 0;
        err = record(session, handle_message(session, &s_message), "Command");
    }
    session->wait_ms = 0;
    return err;
}

static esp_err_t fetch_once(session_t *session) {
    size_t count;
    const esp_err_t err = vds1022_fetch_frames(session->acquisition.channel_mask, s_frames, &count);
    if (err == ESP_OK) {
        stream_publish(s_frames, count * VDS1022_FRAME_SIZE);
        session->fetched++;
        if (session->acquisition.mode == ACQUISITION_SINGLE) {
            session->acquisition.mode = ACQUISITION_STOPPED;
        }
    }
    return err;
}

static esp_err_t acquire_step(session_t *session) {
    bool ready = true;
    esp_err_t err = ESP_OK;
    if (waits_for_trigger(&session->acquisition)) {
        err = vds1022_trigger_ready(&ready);
    }
    if (err == ESP_OK && ready) {
        err = fetch_once(session);
    } else if (err == ESP_OK) {
        session->wait_ms = TRIGGER_WAIT_MS;
    }
    session->last_command_us = esp_timer_get_time();
    return err;
}

static esp_err_t idle_step(session_t *session) {
    esp_err_t err = ESP_OK;
    const int64_t now_us = esp_timer_get_time();
    session->wait_ms = IDLE_WAIT_MS;
    if (now_us - session->last_command_us >= KEEPALIVE_PERIOD_US) {
        err = vds1022_keepalive();
        session->last_command_us = now_us;
    }
    return err;
}

static esp_err_t step(session_t *session) {
    const bool fetching = is_fetching(&session->acquisition);
    return record(session, fetching ? acquire_step(session) : idle_step(session), "Acquisition");
}

static void start_session(session_t *session) {
    *session = (session_t){
        .acquisition = {.channel_mask = VDS1022_ALL_CHANNELS, .mode = ACQUISITION_FREE_RUNNING},
        .last_command_us = esp_timer_get_time(),
    };
    control_flush();
    stream_broadcast_text(SCOPE_READY_EVENT);
}

static esp_err_t acquire_until_failure(void) {
    esp_err_t err = ESP_OK;
    session_t session;
    start_session(&session);
    int64_t next_stats_us = esp_timer_get_time() + STATS_PERIOD_US;
    while (err == ESP_OK) {
        err = handle_messages(&session);
        if (err == ESP_OK) {
            err = step(&session);
        }
        if (esp_timer_get_time() >= next_stats_us) {
            log_stats(&session);
            next_stats_us += STATS_PERIOD_US;
        }
    }
    return err;
}

void app_main(void) {
    ESP_ERROR_CHECK(log_buffer_start());
    ESP_ERROR_CHECK(wifi_manager_start());
    ESP_ERROR_CHECK(captive_dns_start());
    ESP_ERROR_CHECK(control_start());
    ESP_ERROR_CHECK(stream_start(sizeof(s_frames)));
    ESP_ERROR_CHECK(web_server_start());
    ESP_ERROR_CHECK(scope_usb_start());
    ESP_ERROR_CHECK(firmware_update_confirm_later());
    ESP_LOGI(TAG, "Waiting for the scope");
    for (;;) {
        scope_usb_wait_for_scope();
        esp_err_t err = prepare_scope();
        if (err == ESP_OK) {
            err = acquire_until_failure();
        }
        ESP_LOGE(TAG, "Scope session ended: %s", esp_err_to_name(err));
        vds1022_end_session();
        scope_usb_close();
    }
}
