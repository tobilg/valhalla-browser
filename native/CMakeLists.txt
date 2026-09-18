cmake_minimum_required(VERSION 3.22)
project(valhalla_browser LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 20)
if(EMSCRIPTEN)
  add_executable(protobuf::protoc IMPORTED GLOBAL)
  set_target_properties(protobuf::protoc PROPERTIES IMPORTED_LOCATION /usr/bin/protoc)
endif()
add_subdirectory(${VALHALLA_SOURCE} upstream)
if(EMSCRIPTEN)
  add_executable(valhalla-browser runtime.cpp)
  execute_process(COMMAND git -C ${VALHALLA_SOURCE} rev-parse HEAD
    OUTPUT_VARIABLE source_revision OUTPUT_STRIP_TRAILING_WHITESPACE COMMAND_ERROR_IS_FATAL ANY)
  target_compile_definitions(valhalla-browser PRIVATE VB_SOURCE_REVISION="${source_revision}")
  target_link_libraries(valhalla-browser PRIVATE valhalla)
  target_compile_options(valhalla-browser PRIVATE -O3 -fexceptions)
  target_link_options(valhalla-browser PRIVATE
    -O3 -fexceptions --no-entry
    -sASYNCIFY=1 -sASYNCIFY_IGNORE_INDIRECT=0 -sASYNCIFY_STACK_SIZE=131072
    -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912
    -sSTACK_SIZE=2097152 -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=worker
    -sFILESYSTEM=1 -sASSERTIONS=1
    "-sEXPORTED_FUNCTIONS=['_vb_init','_vb_route','_vb_dispose','_vb_stats','_malloc','_free']"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','UTF8ToString','FS']")
else()
  add_executable(native-reference reference.cpp)
  target_link_libraries(native-reference PRIVATE valhalla)
endif()
