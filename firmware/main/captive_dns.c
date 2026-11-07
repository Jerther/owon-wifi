#include "captive_dns.h"

#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#define DNS_PORT 53
#define TASK_STACK 4096
#define TASK_PRIORITY 3
#define HEADER_SIZE 12
#define QUESTION_TAIL_SIZE 4
#define MAX_QUERY_SIZE 512
#define ANSWER_TTL_S 60
#define TYPE_A 1
#define CLASS_IN 1
#define FLAG_RESPONSE 0x8000
#define FLAG_RECURSION_DESIRED 0x0100
#define FLAG_RECURSION_AVAILABLE 0x0080
#define NAME_POINTER_TO_QUESTION 0xC00C

static const char *TAG = "captive_dns";

static const uint8_t ANSWER_ADDRESS[4] = {192, 168, 4, 1};

static uint16_t read_u16(const uint8_t *data) {
    return (uint16_t)((data[0] << 8) | data[1]);
}

static uint8_t *write_u16(uint8_t *out, uint16_t value) {
    out[0] = (uint8_t)(value >> 8);
    out[1] = (uint8_t)value;
    return out + 2;
}

static uint8_t *write_u32(uint8_t *out, uint32_t value) {
    out = write_u16(out, (uint16_t)(value >> 16));
    return write_u16(out, (uint16_t)value);
}

/** Returns the offset just past the first question, or 0 when it is malformed or runs past the packet. */
static size_t question_end(const uint8_t *query, size_t length) {
    size_t end = 0;
    size_t offset = HEADER_SIZE;
    bool valid = true;
    while (valid && offset < length && query[offset] != 0) {
        valid = (query[offset] & 0xC0) == 0;
        offset += query[offset] + 1;
    }
    if (valid && offset + 1 + QUESTION_TAIL_SIZE <= length) {
        end = offset + 1 + QUESTION_TAIL_SIZE;
    }
    return end;
}

static bool is_usable_query(const uint8_t *query, size_t length) {
    return length >= HEADER_SIZE && (read_u16(&query[2]) & FLAG_RESPONSE) == 0 && read_u16(&query[4]) >= 1;
}

/** Returns the reply size, or 0 when the packet must be ignored. */
static size_t build_reply(const uint8_t *query, size_t length, uint8_t *reply) {
    size_t size = 0;
    const size_t end = is_usable_query(query, length) ? question_end(query, length) : 0;
    if (end != 0) {
        const bool is_address_query = read_u16(&query[end - QUESTION_TAIL_SIZE]) == TYPE_A &&
                                      read_u16(&query[end - QUESTION_TAIL_SIZE + 2]) == CLASS_IN;
        memcpy(reply, query, end);
        write_u16(&reply[2], FLAG_RESPONSE | FLAG_RECURSION_AVAILABLE | (read_u16(&query[2]) & FLAG_RECURSION_DESIRED));
        write_u16(&reply[4], 1);
        write_u16(&reply[6], is_address_query ? 1 : 0);
        write_u16(&reply[8], 0);
        write_u16(&reply[10], 0);
        size = end;
        if (is_address_query) {
            uint8_t *out = write_u16(&reply[size], NAME_POINTER_TO_QUESTION);
            out = write_u16(out, TYPE_A);
            out = write_u16(out, CLASS_IN);
            out = write_u32(out, ANSWER_TTL_S);
            out = write_u16(out, sizeof(ANSWER_ADDRESS));
            memcpy(out, ANSWER_ADDRESS, sizeof(ANSWER_ADDRESS));
            size = (size_t)(out + sizeof(ANSWER_ADDRESS) - reply);
        }
    }
    return size;
}

static void answer_forever(int sock) {
    uint8_t query[MAX_QUERY_SIZE];
    uint8_t reply[MAX_QUERY_SIZE + 16];
    for (;;) {
        struct sockaddr_in source;
        socklen_t source_size = sizeof(source);
        const int length = recvfrom(sock, query, sizeof(query), 0, (struct sockaddr *)&source, &source_size);
        const size_t reply_size = length > 0 ? build_reply(query, (size_t)length, reply) : 0;
        if (reply_size > 0) {
            sendto(sock, reply, reply_size, 0, (struct sockaddr *)&source, source_size);
        }
    }
}

static int open_socket(void) {
    const struct sockaddr_in address = {
        .sin_family = AF_INET,
        .sin_port = htons(DNS_PORT),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock >= 0 && bind(sock, (const struct sockaddr *)&address, sizeof(address)) != 0) {
        close(sock);
        sock = -1;
    }
    return sock;
}

static void dns_task(void *arg) {
    const int sock = open_socket();
    if (sock >= 0) {
        answer_forever(sock);
    }
    ESP_LOGE(TAG, "Cannot open the DNS socket");
    vTaskDelete(NULL);
}

esp_err_t captive_dns_start(void) {
    const BaseType_t created = xTaskCreate(dns_task, "dns", TASK_STACK, NULL, TASK_PRIORITY, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
