cmake_minimum_required(VERSION 3.18)
project(chap_p8_ufpr_a LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Threads REQUIRED)
find_package(highs CONFIG REQUIRED)
find_package(CUDAToolkit REQUIRED)
set(CHAP_ROOT "/home/user/jing_workspace/chap_repro")
add_library(p3b_gpu_core STATIC IMPORTED GLOBAL)
set_target_properties(p3b_gpu_core PROPERTIES
  IMPORTED_LOCATION "${CHAP_ROOT}/build_p3b_gpu_tabu/libchap_gpu_tabu.a"
  INTERFACE_INCLUDE_DIRECTORIES "${CHAP_ROOT}/p3b_gpu_tabu")
add_library(p3c_policy STATIC IMPORTED GLOBAL)
set_target_properties(p3c_policy PROPERTIES
  IMPORTED_LOCATION "${CHAP_ROOT}/build_p3c_tabu_policy/libp3c_policy.a"
  INTERFACE_INCLUDE_DIRECTORIES "${CHAP_ROOT}/p3c_tabu_policy")
set(GUROBI_ROOT "/home/user/.julia/artifacts/f0e5f5a89f78144698ed87413adc7743688584f5/gurobi1300/linux64")
add_executable(chap_p8_ufpr_a main.cpp)
target_include_directories(chap_p8_ufpr_a PRIVATE
  "${CHAP_ROOT}/src/cuPDLPx/include"
  "${CHAP_ROOT}/build/cupdlpx/_deps/pslp-src/include/PSLP"
  "${CHAP_ROOT}/p3b_gpu_tabu"
  "${CHAP_ROOT}/p3c_tabu_policy"
  "${GUROBI_ROOT}/include")
target_link_libraries(chap_p8_ufpr_a PRIVATE
  highs::highs
  Threads::Threads
  p3c_policy
  p3b_gpu_core
  CUDA::cudart
  "${CHAP_ROOT}/build/cupdlpx/libcupdlpx.so"
  "${GUROBI_ROOT}/lib/libgurobi130.so")
set_target_properties(chap_p8_ufpr_a PROPERTIES
  BUILD_RPATH "${CHAP_ROOT}/build/cupdlpx;${CHAP_ROOT}/build/cupdlpx/_deps/pslp-build;${GUROBI_ROOT}/lib")
target_compile_options(chap_p8_ufpr_a PRIVATE -O2 -ffp-contract=off -Wall -Wextra -Wpedantic)
