cmake_minimum_required(VERSION 3.16)

project(krot_cpp_core VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(krot_cpp_core_lib
  src/height_map.cpp
  src/matcher.cpp
  src/nmea.cpp
  src/profile.cpp
  src/scoring.cpp
)

target_include_directories(krot_cpp_core_lib PUBLIC src)

if(MSVC)
  target_compile_options(krot_cpp_core_lib PRIVATE /W4)
else()
  target_compile_options(krot_cpp_core_lib PRIVATE -Wall -Wextra -pedantic)
endif()

add_executable(krot_cpp src/main.cpp)
target_link_libraries(krot_cpp PRIVATE krot_cpp_core_lib)

add_executable(krot_cpp_tests tests/test_core.cpp)
target_link_libraries(krot_cpp_tests PRIVATE krot_cpp_core_lib)

enable_testing()
add_test(NAME krot_cpp_core_tests COMMAND krot_cpp_tests)
set_tests_properties(krot_cpp_core_tests PROPERTIES WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR})

