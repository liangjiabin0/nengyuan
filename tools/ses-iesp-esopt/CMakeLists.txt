cmake_minimum_required(VERSION 3.10)
project(OPENTEPES_ESOPT)

set(CMAKE_BUILD_TYPE Release)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED True)

get_filename_component(PROJECT_ESOPT_ROOT "${CMAKE_CURRENT_LIST_DIR}/../esopt/src/install" ABSOLUTE)
set(ESOPT_ROOT "${PROJECT_ESOPT_ROOT}" CACHE PATH "ESOPT install prefix")

include_directories(
    ${ESOPT_ROOT}/include
    ${ESOPT_ROOT}/include/thirdparty
    ${ESOPT_ROOT}/include/thirdparty/solvers/knitro/include
    ${ESOPT_ROOT}/include/thirdparty/solvers/highs/
    ${ESOPT_ROOT}/include/thirdparty/solvers/cupdlpx/
    ${ESOPT_ROOT}/include/thirdparty/cppad/include
    ${CMAKE_CURRENT_SOURCE_DIR}
)

add_executable(openTEPES_esopt
    openTEPES_Main.cpp
    openTEPES.cpp
    openTEPES_InputData.cpp
    openTEPES_ModelFormulation.cpp
    openTEPES_ProblemSolving.cpp
    openTEPES_OutputResults.cpp
)

target_compile_definitions(openTEPES_esopt PRIVATE
    OPENTEPES_DEFAULT_DIR="${CMAKE_CURRENT_SOURCE_DIR}"
)

set(CMAKE_RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)

target_link_libraries(openTEPES_esopt PRIVATE
    ${ESOPT_ROOT}/bin/libOptInterface.dll
    ${ESOPT_ROOT}/bin/libtcc.dll
)

if(WIN32)
    add_custom_command(TARGET openTEPES_esopt POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${ESOPT_ROOT}/bin/libOptInterface.dll"
            "$<TARGET_FILE_DIR:openTEPES_esopt>"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${ESOPT_ROOT}/bin/libtcc.dll"
            "$<TARGET_FILE_DIR:openTEPES_esopt>"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${ESOPT_ROOT}/bin/libPSLP.dll"
            "$<TARGET_FILE_DIR:openTEPES_esopt>"
    )
endif()
