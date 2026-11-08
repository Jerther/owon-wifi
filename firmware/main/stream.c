#include "stream.h"

#include <string.h>
#include "control.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#define MAX_SOCKETS STREAM_MAX_SOCKETS
#define SENDER_STACK 4096
#define SENDER_PRIORITY 5
#define HEADER_SIZE sizeof(uint32_t)
#define FLAG_BITS (STREAM_SINGLE_CAPTURE | STREAM_SINGLE_FILLING)
#define MAX_TEXT_SIZE 1024
#define MAX_BINARY_SIZE CONTROL_MAX_MESSAGE
#define MAX_INCOMING_SIZE MAX_TEXT_SIZE
#define NO_SOCKET -1
#define STATE_QUERY "state?"
#define EMPTY_STATE "{\"state\":null}"

static const char *TAG = "stream";

static httpd_handle_t s_server;
static TaskHandle_t s_sender;
static SemaphoreHandle_t s_latest_lock;
// The sender and the echo reply share a socket, and a WebSocket send is not atomic.
static SemaphoreHandle_t s_send_lock;
static size_t s_capacity;
static size_t s_latest_size;
static size_t s_outgoing_size;
static uint8_t *s_latest;
static uint8_t *s_outgoing;
static uint32_t s_sequence;
static volatile uint32_t s_sent_count;
// Only the server task touches these: the incoming message, and the browsers' shared state as they last sent it.
static uint8_t s_incoming[MAX_INCOMING_SIZE];
static uint8_t s_state[MAX_TEXT_SIZE];
static size_t s_state_size;

static esp_err_t send_echo(httpd_req_t *request, httpd_ws_frame_t *frame) {
    xSemaphoreTake(s_send_lock, portMAX_DELAY);
    const esp_err_t err = httpd_ws_send_frame(request, frame);
    xSemaphoreGive(s_send_lock);
    return err;
}

static size_t max_payload(httpd_ws_type_t type) {
    return type == HTTPD_WS_TYPE_TEXT ? MAX_TEXT_SIZE : MAX_BINARY_SIZE;
}

static void send_to_client(int fd, httpd_ws_frame_t *frame) {
    xSemaphoreTake(s_send_lock, portMAX_DELAY);
    const esp_err_t err = httpd_ws_send_frame_async(s_server, fd, frame);
    xSemaphoreGive(s_send_lock);
    if (err == ESP_OK) {
        s_sent_count++;
    } else {
        ESP_LOGW(TAG, "Dropping client on socket %d: %s", fd, esp_err_to_name(err));
        httpd_sess_trigger_close(s_server, fd);
    }
}

static void send_to_other_clients(int sender_fd, httpd_ws_frame_t *frame) {
    int fds[MAX_SOCKETS];
    size_t count = MAX_SOCKETS;
    if (httpd_get_client_list(s_server, &count, fds) == ESP_OK) {
        for (size_t i = 0; i < count; i++) {
            const bool is_websocket = httpd_ws_get_fd_info(s_server, fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET;
            if (is_websocket && fds[i] != sender_fd) {
                send_to_client(fds[i], frame);
            }
        }
    }
}

static void send_to_clients(httpd_ws_frame_t *frame) {
    send_to_other_clients(NO_SOCKET, frame);
}

static bool is_state(const httpd_ws_frame_t *frame) {
    return frame->len > 0 && frame->payload[0] == '{';
}

static bool is_state_query(const httpd_ws_frame_t *frame) {
    return frame->len == strlen(STATE_QUERY) && memcmp(frame->payload, STATE_QUERY, frame->len) == 0;
}

static void share_state(httpd_req_t *request, httpd_ws_frame_t *frame) {
    memcpy(s_state, frame->payload, frame->len);
    s_state_size = frame->len;
    send_to_other_clients(httpd_req_to_sockfd(request), frame);
}

static esp_err_t reply_state(httpd_req_t *request) {
    httpd_ws_frame_t reply = {.type = HTTPD_WS_TYPE_TEXT, .payload = s_state, .len = s_state_size};
    if (s_state_size == 0) {
        reply.payload = (uint8_t *)EMPTY_STATE;
        reply.len = strlen(EMPTY_STATE);
    }
    return send_echo(request, &reply);
}

// Text is a shared state to relay, a query for it, or a timestamp to echo for the round trip.
static esp_err_t handle_text(httpd_req_t *request, httpd_ws_frame_t *frame) {
    esp_err_t err = ESP_OK;
    if (is_state(frame)) {
        share_state(request, frame);
    } else if (is_state_query(frame)) {
        err = reply_state(request);
    } else {
        err = send_echo(request, frame);
    }
    return err;
}

static esp_err_t receive_message(httpd_req_t *request) {
    uint8_t *payload = s_incoming;
    httpd_ws_frame_t frame = {.payload = payload};
    esp_err_t err = httpd_ws_recv_frame(request, &frame, 0);
    if (err == ESP_OK && frame.len > max_payload(frame.type)) {
        err = ESP_ERR_INVALID_SIZE;
    }
    if (err == ESP_OK) {
        err = httpd_ws_recv_frame(request, &frame, frame.len);
    }
    if (err == ESP_OK && frame.type == HTTPD_WS_TYPE_TEXT) {
        err = handle_text(request, &frame);
    } else if (err == ESP_OK && frame.type == HTTPD_WS_TYPE_BINARY) {
        control_submit(payload, frame.len);
    }
    return err;
}

static esp_err_t handle_socket(httpd_req_t *request) {
    esp_err_t err = ESP_OK;
    if (request->method == HTTP_GET) {
        ESP_LOGI(TAG, "Client connected on socket %d", httpd_req_to_sockfd(request));
    } else {
        err = receive_message(request);
    }
    return err;
}

static void sender_task(void *arg) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        xSemaphoreTake(s_latest_lock, portMAX_DELAY);
        s_outgoing_size = s_latest_size;
        memcpy(s_outgoing, s_latest, s_outgoing_size);
        xSemaphoreGive(s_latest_lock);
        httpd_ws_frame_t frame = {
            .type = HTTPD_WS_TYPE_BINARY,
            .payload = s_outgoing,
            .len = s_outgoing_size,
        };
        send_to_clients(&frame);
    }
}

void stream_broadcast_text(const char *text) {
    httpd_ws_frame_t frame = {
        .type = HTTPD_WS_TYPE_TEXT,
        .payload = (uint8_t *)text,
        .len = strlen(text),
    };
    send_to_clients(&frame);
}

void stream_publish(const uint8_t *frames, size_t length, uint32_t flags) {
    if (length <= s_capacity - HEADER_SIZE) {
        xSemaphoreTake(s_latest_lock, portMAX_DELAY);
        s_sequence = (s_sequence + 1) & ~FLAG_BITS;
        const uint32_t header = s_sequence | (flags & FLAG_BITS);
        s_latest_size = HEADER_SIZE + length;
        memcpy(s_latest, &header, HEADER_SIZE);
        memcpy(&s_latest[HEADER_SIZE], frames, length);
        xSemaphoreGive(s_latest_lock);
        xTaskNotifyGive(s_sender);
    }
}

uint32_t stream_take_sent_count(void) {
    const uint32_t count = s_sent_count;
    s_sent_count = 0;
    return count;
}

esp_err_t stream_register(httpd_handle_t server) {
    const httpd_uri_t socket = {.uri = "/ws", .method = HTTP_GET, .handler = handle_socket, .is_websocket = true};
    s_server = server;
    return httpd_register_uri_handler(server, &socket);
}

esp_err_t stream_start(size_t max_frames_size) {
    esp_err_t err = ESP_ERR_NO_MEM;
    s_capacity = HEADER_SIZE + max_frames_size;
    s_latest = heap_caps_malloc(s_capacity, MALLOC_CAP_INTERNAL);
    s_outgoing = heap_caps_malloc(s_capacity, MALLOC_CAP_INTERNAL);
    s_latest_lock = xSemaphoreCreateMutex();
    s_send_lock = xSemaphoreCreateMutex();
    if (s_latest != NULL && s_outgoing != NULL) {
        xTaskCreate(sender_task, "stream", SENDER_STACK, NULL, SENDER_PRIORITY, &s_sender);
        err = ESP_OK;
    }
    return err;
}
