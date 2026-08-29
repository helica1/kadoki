#!/bin/bash
# Fetch the CoreML depth models for the visionOS AI-3D video pipeline.
# They are NOT in git (DA3 Base's weights exceed GitHub's 100MB file limit).
# Run once from this directory before building the visionOS target.
set -e
cd "$(dirname "$0")"

fetch() { # repo path
    mkdir -p "$(dirname "$2")"
    echo "→ $2"
    curl -sL "https://huggingface.co/$1/resolve/main/$2" -o "$2"
}

if [ ! -f DepthAnythingV2SmallF16.mlpackage/Data/com.apple.CoreML/weights/weight.bin ]; then
    ( fetch apple/coreml-depth-anything-v2-small DepthAnythingV2SmallF16.mlpackage/Manifest.json
      fetch apple/coreml-depth-anything-v2-small DepthAnythingV2SmallF16.mlpackage/Data/com.apple.CoreML/model.mlmodel
      fetch apple/coreml-depth-anything-v2-small DepthAnythingV2SmallF16.mlpackage/Data/com.apple.CoreML/weights/weight.bin )
fi
if [ ! -f DepthAnythingV3_base_504.mlpackage/Data/com.apple.CoreML/weights/weight.bin ]; then
    ( fetch mlboydaisuke/Depth-Anything-3-Base-CoreML DepthAnythingV3_base_504.mlpackage/Manifest.json
      fetch mlboydaisuke/Depth-Anything-3-Base-CoreML DepthAnythingV3_base_504.mlpackage/Data/com.apple.CoreML/model.mlmodel
      fetch mlboydaisuke/Depth-Anything-3-Base-CoreML DepthAnythingV3_base_504.mlpackage/Data/com.apple.CoreML/weights/weight.bin )
fi
echo "models ready"
