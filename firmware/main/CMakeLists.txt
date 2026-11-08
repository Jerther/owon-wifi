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
)

set(WEB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../web")
set(WEB_OUT "${CMAKE_CURRENT_BINARY_DIR}/web")
file(GLOB_RECURSE WEB_SOURCES CONFIGURE_DEPENDS "${WEB_DIR}/*")
add_custom_command(
    OUTPUT "${WEB_OUT}/index.html.gz" "${WEB_OUT}/settings.html.gz"
    COMMAND node "${WEB_DIR}/build.mjs" "${WEB_OUT}"
    DEPENDS ${WEB_SOURCES}
    VERBATIM)
add_custom_target(web_bundle DEPENDS "${WEB_OUT}/index.html.gz" "${WEB_OUT}/settings.html.gz")
add_dependencies(${COMPONENT_LIB} web_bundle)
target_add_binary_data(${COMPONENT_LIB} "${WEB_OUT}/index.html.gz" BINARY)
target_add_binary_data(${COMPONENT_LIB} "${WEB_OUT}/settings.html.gz" BINARY)
target_add_binary_data(${COMPONENT_LIB} "${WEB_DIR}/manifest.webmanifest" BINARY)
target_add_binary_data(${COMPONENT_LIB} "${WEB_DIR}/icons/icon.svg" BINARY)
target_add_binary_data(${COMPONENT_LIB} "${WEB_DIR}/icons/icon-192.png" BINARY)
target_add_binary_data(${COMPONENT_LIB} "${WEB_DIR}/icons/icon-512.png" BINARY)
target_add_binary_data(${COMPONENT_LIB} "${WEB_DIR}/icons/icon-maskable.png" BINARY)
