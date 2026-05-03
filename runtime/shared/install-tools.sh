#!/usr/bin/env bash
# Phase 5: shared tool installer reused by both runtime images.
# Adds language runtimes and developer tooling that pods commonly need.
set -euo pipefail

apt-get update
apt-get install -y --no-install-recommends \
  git curl ca-certificates build-essential \
  python3 python3-pip \
  jq unzip
rm -rf /var/lib/apt/lists/*
