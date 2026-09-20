cmake_minimum_required(VERSION 3.22)
project(valhalla_browser LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
if(EMSCRIPTEN)
  add_executable(protobuf::protoc IMPORTED GLOBAL)
  set_target_properties(protobuf::protoc PROPERTIES IMPORTED_LOCATION /usr/bin/protoc)
endif()
add_subdirectory(${VALHALLA_SOURCE} upstream)
if(EMSCRIPTEN)
  execute_process(COMMAND git -C ${VALHALLA_SOURCE} rev-parse HEAD
    OUTPUT_VARIABLE source_revision OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
  # One host-neutral runtime. Adapters supply instantiation and imported memory.
  add_executable(valhalla-runtime runtime.cpp)
  set_target_properties(valhalla-runtime PROPERTIES OUTPUT_NAME valhalla)
  target_compile_definitions(valhalla-runtime PRIVATE VB_SOURCE_REVISION="${source_revision}")
  target_link_libraries(valhalla-runtime PRIVATE valhalla)
  target_compile_options(valhalla-runtime PRIVATE -O3 -fexceptions)
  target_link_options(valhalla-runtime PRIVATE
    -O3 -fexceptions --no-entry
    --js-library=${CMAKE_CURRENT_SOURCE_DIR}/runtime-library.js
    -sASYNCIFY=1 -sASYNCIFY_IGNORE_INDIRECT=0 -sASYNCIFY_STACK_SIZE=131072
    -sALLOW_MEMORY_GROWTH=1 -sIMPORTED_MEMORY=1
    -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=1073741824
    -sSTACK_SIZE=2097152 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=shell
    -sFILESYSTEM=1 -sASSERTIONS=0
    "-sINCOMING_MODULE_JS_API=['instantiateWasm','wasmMemory','print','printErr']"
    "-sEXPORTED_FUNCTIONS=['_vb_init','_vb_route','_vb_dispose','_vb_stats','_malloc','_free']"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','UTF8ToString','FS']")
  set_property(TARGET valhalla-runtime APPEND PROPERTY LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/runtime-library.js)
else()
  add_executable(native-reference reference.cpp)
  target_link_libraries(native-reference PRIVATE valhalla)
endif()
