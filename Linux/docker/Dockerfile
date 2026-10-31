# UNVERIFIED LOCALLY (no Docker available); CI verifies the equivalent steps.
# Build/test image for the Linux port: Ubuntu 22.04 baseline.
# wine (the launcher; wine64 satisfies it, no i386 needed) and mingw-w64 are for the
# Wine-harness step of run-tests.sh (Linux/test-harness/README.md).
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 git curl ca-certificates rsync wine wine64 mingw-w64 \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
