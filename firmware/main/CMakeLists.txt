set(FPGA_DIR "../../OWON-VDS1022/fwr")

idf_component_register(
    SRCS "main.c" "scope_usb.c" "vds1022.c" "wifi_manager.c" "captive_dns.c" "log_buffer.c"
         "firmware_update.c" "web_server.c" "stream.c" "control.c"
    INCLUDE_DIRS "."
    REQUIRES usb esp_timer esp_psram esp_wifi esp_netif esp_event nvs_flash esp_http_server
             esp_system lwip json app_update esp_app_format
    EMBED_FILES
        "${FPGA_DIR}/VDS1022_FPGAV1_V3.9.bin"
        "${FPGA_DIR}/VDS1022_FPGAV2_V4.1.bin"
        "${FPGA_DIR}/VDS1022_FPGAV3_gaoyun.bin"
        "${FPGA_DIR}/VDS1022_FPGAV4_gaoyun.bin"
        "${FPGA_DIR}/VDS1022_FPGAV5_gaoyun.bin"
        "index.html"
        "settings.html"
        "app.js"
        "scope_logic.js"
)
