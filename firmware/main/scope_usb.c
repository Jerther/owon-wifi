#include "scope_usb.h"

#include <string.h>
#include "esp_intr_alloc.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "usb/usb_helpers.h"
#include "usb/usb_host.h"

#define SCOPE_VID 0x5345
#define SCOPE_PID 0x1234
#define SCOPE_INTERFACE 0
#define SCOPE_EP_IN 0x81
#define SCOPE_EP_OUT 0x03
#define SCOPE_MPS 64

// A frame is 5211 bytes. IN transfers must be a multiple of the packet size;
// the scope's short packet ends them early.
#define READ_BUFFER_SIZE (82 * SCOPE_MPS)
#define TRANSFER_TIMEOUT_MS 200
#define USB_TASK_STACK 4096
#define USB_LIB_TASK_PRIORITY 20
#define USB_CLIENT_TASK_PRIORITY 19

static const char *TAG = "scope_usb";

static usb_host_client_handle_t s_client;
static usb_device_handle_t s_device;
static usb_transfer_t *s_write_transfer;
static usb_transfer_t *s_read_transfer;
static SemaphoreHandle_t s_transfer_done;
static QueueHandle_t s_new_devices;

static void usb_lib_task(void *arg) {
    for (;;) {
        uint32_t flags;
        usb_host_lib_handle_events(portMAX_DELAY, &flags);
    }
}

static void usb_client_task(void *arg) {
    for (;;) {
        usb_host_client_handle_events(s_client, portMAX_DELAY);
    }
}

static void on_client_event(const usb_host_client_event_msg_t *event, void *arg) {
    if (event->event == USB_HOST_CLIENT_EVENT_NEW_DEV) {
        xQueueSend(s_new_devices, &event->new_dev.address, 0);
    } else {
        ESP_LOGW(TAG, "Device unplugged");
    }
}

static void on_transfer_done(usb_transfer_t *transfer) {
    xSemaphoreGive(s_transfer_done);
}

static esp_err_t allocate_transfer(size_t size, uint8_t endpoint, usb_transfer_t **transfer) {
    esp_err_t err = usb_host_transfer_alloc(size, 0, transfer);
    if (err == ESP_OK) {
        (*transfer)->bEndpointAddress = endpoint;
        (*transfer)->callback = on_transfer_done;
    }
    return err;
}

esp_err_t scope_usb_start(void) {
    s_transfer_done = xSemaphoreCreateBinary();
    s_new_devices = xQueueCreate(4, sizeof(uint8_t));

    const usb_host_config_t host_config = {.intr_flags = ESP_INTR_FLAG_LEVEL1};
    esp_err_t err = usb_host_install(&host_config);
    if (err == ESP_OK) {
        xTaskCreate(usb_lib_task, "usb_lib", USB_TASK_STACK, NULL, USB_LIB_TASK_PRIORITY, NULL);
        const usb_host_client_config_t client_config = {
            .is_synchronous = false,
            .max_num_event_msg = 5,
            .async = {.client_event_callback = on_client_event},
        };
        err = usb_host_client_register(&client_config, &s_client);
    }
    if (err == ESP_OK) {
        xTaskCreate(usb_client_task, "usb_client", USB_TASK_STACK, NULL, USB_CLIENT_TASK_PRIORITY, NULL);
        err = allocate_transfer(SCOPE_USB_MAX_WRITE, SCOPE_EP_OUT, &s_write_transfer);
    }
    if (err == ESP_OK) {
        err = allocate_transfer(READ_BUFFER_SIZE, SCOPE_EP_IN, &s_read_transfer);
    }
    return err;
}

static bool is_scope(usb_device_handle_t device) {
    const usb_device_desc_t *descriptor;
    bool matches = false;
    if (usb_host_get_device_descriptor(device, &descriptor) == ESP_OK) {
        matches = descriptor->idVendor == SCOPE_VID && descriptor->idProduct == SCOPE_PID;
        usb_print_device_descriptor(descriptor);
    }
    return matches;
}

static void print_config_descriptor(usb_device_handle_t device) {
    const usb_config_desc_t *descriptor;
    if (usb_host_get_active_config_descriptor(device, &descriptor) == ESP_OK) {
        usb_print_config_descriptor(descriptor, NULL);
    }
}

static esp_err_t claim_scope(usb_device_handle_t device) {
    esp_err_t err = ESP_ERR_NOT_SUPPORTED;
    if (is_scope(device)) {
        print_config_descriptor(device);
        err = usb_host_interface_claim(s_client, device, SCOPE_INTERFACE, 0);
    }
    return err;
}

void scope_usb_wait_for_scope(void) {
    s_device = NULL;
    while (s_device == NULL) {
        uint8_t address;
        usb_device_handle_t device;
        xQueueReceive(s_new_devices, &address, portMAX_DELAY);
        ESP_LOGI(TAG, "New device at address %d", address);
        esp_err_t err = usb_host_device_open(s_client, address, &device);
        if (err == ESP_OK) {
            err = claim_scope(device);
            if (err == ESP_OK) {
                s_device = device;
            } else {
                usb_host_device_close(s_client, device);
            }
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Could not claim device: %s", esp_err_to_name(err));
        }
    }
}

void scope_usb_close(void) {
    usb_host_interface_release(s_client, s_device, SCOPE_INTERFACE);
    usb_host_device_close(s_client, s_device);
    s_device = NULL;
}

static void cancel_transfer(usb_transfer_t *transfer) {
    usb_host_endpoint_halt(s_device, transfer->bEndpointAddress);
    usb_host_endpoint_flush(s_device, transfer->bEndpointAddress);
    xSemaphoreTake(s_transfer_done, pdMS_TO_TICKS(TRANSFER_TIMEOUT_MS));
    usb_host_endpoint_clear(s_device, transfer->bEndpointAddress);
}

static esp_err_t run_transfer(usb_transfer_t *transfer) {
    transfer->device_handle = s_device;
    esp_err_t err = usb_host_transfer_submit(transfer);
    if (err == ESP_OK) {
        if (xSemaphoreTake(s_transfer_done, pdMS_TO_TICKS(TRANSFER_TIMEOUT_MS)) == pdTRUE) {
            err = transfer->status == USB_TRANSFER_STATUS_COMPLETED ? ESP_OK : ESP_FAIL;
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "Transfer on EP 0x%02x failed, status %d", transfer->bEndpointAddress, transfer->status);
            }
        } else {
            // The USB host library has no bulk transfer timeout of its own.
            cancel_transfer(transfer);
            err = ESP_ERR_TIMEOUT;
        }
    }
    return err;
}

esp_err_t scope_usb_write(const void *data, size_t length) {
    esp_err_t err = ESP_ERR_INVALID_SIZE;
    if (length <= SCOPE_USB_MAX_WRITE) {
        memcpy(s_write_transfer->data_buffer, data, length);
        s_write_transfer->num_bytes = length;
        err = run_transfer(s_write_transfer);
    }
    return err;
}

esp_err_t scope_usb_read(void *data, size_t capacity, size_t *length) {
    s_read_transfer->num_bytes = READ_BUFFER_SIZE;
    esp_err_t err = run_transfer(s_read_transfer);
    if (err == ESP_OK) {
        *length = s_read_transfer->actual_num_bytes;
        if (*length <= capacity) {
            memcpy(data, s_read_transfer->data_buffer, *length);
        } else {
            err = ESP_ERR_INVALID_SIZE;
        }
    }
    return err;
}
