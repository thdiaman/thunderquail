#!/bin/sh
set -eu

cd "$(dirname "$0")"

if [ ! -f embeddings.py ] || [ ! -f gpu_server.py ]; then
    printf '%s\n' 'Place setup-gpu.sh next to the GPU copies of embeddings.py and gpu_server.py.' >&2
    exit 1
fi

if [ ! -x .venv/bin/python ]; then
    python3 -m venv .venv
fi
python=.venv/bin/python

"$python" -m pip install 'torch==2.4.1' \
    --index-url https://download.pytorch.org/whl/cu121
"$python" -m pip install Flask numpy huggingface-hub tokenizers 'onnxruntime-gpu==1.20.2'

# ONNX Runtime 1.20 loads cuDNN libraries from the Linux loader search path.
cuda_libraries=$("$python" -c '
from pathlib import Path
import sysconfig
root = Path(sysconfig.get_path("purelib")) / "nvidia"
print(":".join(str(path) for path in sorted(root.glob("*/lib")) if path.is_dir()))
')
if [ -n "$cuda_libraries" ]; then
    export LD_LIBRARY_PATH="$cuda_libraries${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

"$python" -c 'import torch; assert torch.cuda.is_available(), "CUDA is unavailable"; print("CUDA", torch.version.cuda, "-", torch.cuda.get_device_name(0))'

if [ ! -e .gpu-token ]; then
    (umask 077; set -C; "$python" -c 'import secrets; print(secrets.token_hex(32))' > .gpu-token)
fi
chmod 600 .gpu-token
TQ_GPU_TOKEN=$(cat .gpu-token)
if [ -z "$TQ_GPU_TOKEN" ]; then
    printf '%s\n' 'The existing .gpu-token file is empty. Replace it with a valid token before starting.' >&2
    exit 1
fi
export TQ_GPU_TOKEN
: "${TQ_GPU_BIND:=127.0.0.1}"
export TQ_GPU_BIND

printf 'Starting the GPU endpoint on http://%s:5100\n' "$TQ_GPU_BIND"
exec "$python" gpu_server.py
