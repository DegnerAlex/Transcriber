# Copyright 2026 Alex Degner (alex@ergofox.me)
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

FROM ubuntu:26.04

RUN apt-get update && apt-get install -y
RUN apt install -y libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  pkg-config libudev-dev libasound2-dev libpcsclite-dev \
  cmake \
  git

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y 
ENV PATH="/root/.cargo/bin:${PATH}"
RUN rustup update

RUN cargo install tauri-cli --version "^2.0.0" --locked && \
    cargo install create-tauri-app --locked

RUN apt-get install -y \
    libwayland-client0 \
    libwayland-egl1 \
    libwayland-cursor0

RUN apt-get install -y \
    clang \
    fuse3

## CUDA 13.1 runtime libraries from multiverse — required by the ONNX Runtime
## CUDA EP: libcudart.so.13, libcublas.so.13, libcublasLt.so.13, libcurand.so.10.
#RUN apt-get update && apt-get install -y --no-install-recommends \
#    cuda-cudart-13-1 \
#    libcublas-13-1 \
#    libcurand-13-1
#
## cuDNN 9 for CUDA 13 — ORT lazily loads libcudnn.so for convolution ops.
## The runtime package ships no libcudnn.so symlink, so we create it manually.
#RUN curl -fsSL -o /tmp/cudnn.deb \
#      https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/libcudnn9-cuda-13_9.28.1.4-1_amd64.deb \
#    && apt-get install -y /tmp/cudnn.deb \
#    && rm /tmp/cudnn.deb \
#    && ln -s libcudnn.so.9 /usr/lib/x86_64-linux-gnu/libcudnn.so
#
## ONNX Runtime with CUDA EP (the app loads it from /opt/onnxruntime).
#RUN mkdir -p /opt/onnxruntime && \
#    curl -fsSL https://github.com/microsoft/onnxruntime/releases/download/v1.31.1/onnxruntime-linux-x64-gpu_cuda13-1.31.1.tgz | \
#    tar -xz -C /opt/onnxruntime --strip-components=2 onnxruntime-linux-x64-gpu_cuda13-1.31.1/lib && \
#    echo "/opt/onnxruntime" > /etc/ld.so.conf.d/onnxruntime.conf && \
#    echo "/usr/local/cuda-13.1/targets/x86_64-linux/lib" > /etc/ld.so.conf.d/cuda13.conf && \
#    ldconfig

RUN curl -sL https://deb.nodesource.com/setup_22.x | bash - && \
        apt-get install -y nodejs && \
        npm install --global --allow-scripts=pnpm pnpm

# CUDA 13.1 toolkit (nvcc) + runtime libs for whisper.cpp GGML_CUDA.
# The ubuntu2404 NVIDIA repo is used because there is no 26.04 repo yet;
# the binaries are glibc-forward compatible with 26.04.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends gnupg && \
    wget -qO- https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/3bf863cc.pub | \
      gpg --dearmor --yes -o /usr/share/keyrings/cuda-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/cuda-archive-keyring.gpg] https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2404/x86_64/ /" \
      > /etc/apt/sources.list.d/cuda.list && \
    apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      cuda-nvcc-13-1 \
      cuda-cudart-13-1 \
      cuda-cudart-dev-13-1 \
      libcublas-13-1 \
      libcublas-dev-13-1 && \
    rm -rf /var/lib/apt/lists/* && \
    echo "/usr/local/cuda-13.1/lib64" > /etc/ld.so.conf.d/cuda.conf && \
    ldconfig

ENV CUDA_HOME=/usr/local/cuda-13.1
ENV PATH="/usr/local/cuda-13.1/bin:${PATH}"

# nvcc 13.1 cannot parse GCC 15 headers (Ubuntu 26.04 default), so CUDA
# compilation needs an older host compiler.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends g++-14 && \
    rm -rf /var/lib/apt/lists/*
ENV CUDAHOSTCXX=/usr/bin/g++-14
ENV NVCC_CCBIN=/usr/bin/g++-14

# Vulkan for whisper.cpp GGML_VULKAN (AMD/Intel GPU support): headers +
# loader for linking, glslc compiles the ggml compute shaders at build
# time, libshaderc is linked into the binary for runtime shader compilation.
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      libvulkan-dev \
      libshaderc-dev \
      glslc && \
    rm -rf /var/lib/apt/lists/*

# PipeWire client library for the cpal pipewire host (lets us capture the
# audio playing through output devices / sinks for transcription).
# pipewire-bin provides the client-side SPA modules and configs that the
# libpipewire connection needs (without them host init fails silently).
RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
      libpipewire-0.3-dev \
      libpipewire-0.3-0 \
      pipewire-bin && \
    rm -rf /var/lib/apt/lists/*

# glibc 2.42 added C23 math functions (rsqrt, powr, rootn) that conflict with
# CUDA's own crt/math_functions.h declarations. Hide them from nvcc compiles
# only (__CUDACC__), leaving regular builds untouched.
RUN sed -i 's/^#if __GLIBC_USE (IEC_60559_FUNCS_EXT_C23)/#if __GLIBC_USE (IEC_60559_FUNCS_EXT_C23) \&\& !defined(__CUDACC__)/' \
    /usr/include/x86_64-linux-gnu/bits/mathcalls.h
