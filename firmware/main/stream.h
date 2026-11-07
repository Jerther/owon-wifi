#pragma once

#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#include "esp_http_server.h"

#define STREAM_MAX_SOCKETS 7

/** Prepares the frame sender. `max_frames_size` is the size of the largest set of frames. */
esp_err_t stream_start(size_t max_frames_size);

/** Serves the frame stream on `/ws` of an already started server. */
esp_err_t stream_register(httpd_handle_t server);

/** Replaces the frames waiting to be sent. Never blocks on the network, so a slow client only misses frames. */
void stream_publish(const uint8_t *frames, size_t length);

/** Sends a text message to every WebSocket client. */
void stream_broadcast_text(const char *text);

uint32_t stream_take_sent_count(void);
