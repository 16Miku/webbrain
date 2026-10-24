// Package localmodel installs and runs PrismML's Ternary Bonsai 2 27B on the
// user's machine (GGUF through PrismML's llama.cpp fork, or MLX on Apple
// Silicon) and registers it with the proxy as an OpenAI-compatible model.
package localmodel

import (
	"fmt"
	"os"
)

// File is one pinned download.
type File struct {
	Name   string // path inside the repository
	Size   int64
	SHA256 string // empty for files we only size-check
}

func hfURL(repo, rev, name string) string {
	return fmt.Sprintf("https://huggingface.co/%s/resolve/%s/%s", repo, rev, name)
}

const (
	ModelID      = "bonsai-2-27b"
	ModelName    = "Bonsai 2 27B"
	ModelVendor  = "PrismML"
	ModelPageURL = "https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf"
)

// GGUF: the smallest packing (PTQ1_0, dense trits) plus the Q8_0 vision projector.
var gguf = struct {
	Repo, Rev   string
	Model, Proj File
}{
	Repo:  "prism-ml/Ternary-Bonsai-2-27B-gguf",
	Rev:   "b072e1d3b35a0a630cece372c2127528e0994386",
	Model: File{"Ternary-Bonsai-2-27B-PTQ1_0.gguf", 5946648928, "53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3"},
	Proj:  File{"Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf", 629246976, "6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903"},
}

// MLX: the 2-bit pack (vision tower included) served by native mlx-vlm.
var mlxPack = struct {
	Repo, Rev, Dir string
	Files          []File
}{
	Repo: "prism-ml/Ternary-Bonsai-2-27B-mlx-2bit",
	Rev:  "fcba37d2117a7077eac6b613b2668d14d9779edd",
	Dir:  "Ternary-Bonsai-2-27B-mlx-2bit",
	Files: []File{
		{"model.safetensors", 8595477990, "130de5925082c168b7866b2e91b52e44abbafc99017e3ca352b77b5b55a269ed"},
		{"tokenizer.json", 12809320, "0997f410c57a1f4e53b09e4be8f4a172d90edd9564368fb0847030937229b9f3"},
		{"config.json", 58145, "238de7c512cc56a733421e3fd011d88f8260739e3d00e32c5d65b7943cc9f837"},
		{"hadamard.json", 297903, "7132a3ec364f0bdac1f08f905f24f0ad2f14245060f592637a0396826d3b5fe6"},
		{"tokenizer_config.json", 17928, "b11349aafa7cdc6a320767cf7ceb29ed82f7eda5d65e8e0819e76f0ce947bf27"},
		{"chat_template.jinja", 8952, "c3cf9e34abf4f9e36c2d72165aa9c132d3e2a725b6c2586aaa3a8af9d7a81041"},
		{"generation_config.json", 202, "e70c136c1b78ddc1fb0905bac8e733a4dc448d4f852a5dd75143fffc70be550e"},
		{"preprocessor_config.json", 390, "27225450ac9c6529872ee1924fcb0962ff5634834f817040f444118116f4e516"},
		{"video_preprocessor_config.json", 385, "7768af27c1fafa9cc9011c1dc20067e03f8915e03b63504550e11d5066986d13"},
		{"files.json", 3122, "f0d3b0108d8e52685b81da7916e9943ff9cf2f470fbcc6b24f66a3d562492f1c"},
		{"tokenizer-validation.json", 63, "b36f33d09bd3de3e19de3fd2cf493a69ec0a5e24acf648b0c9fba120d9357554"},
		{"reload-validation.json", 86, "41ec215fe19fa8ad59527fca6594a782d1b7f23b69948ef063311c768217788e"},
		{"PACK-RUNTIME.md", 969, "486bf73b40dab072792cb2e48961a3698d4ca599f1355f3e628e4c64d8aa4cce"},
		{"quickstart.py", 3882, "094ecaee12c0800cec2a68358c3370db7d31abe7757f95f7bf1edde4f4e48cbb"},
		{"runtime/artifact.py", 5621, "5279718d7671bd799e866f53099e82b0260117fec811f83011ba47a0abc7943e"},
		{"runtime/codec.py", 2572, "7f7fd67637a7d9363eab8ebf7db59771830b690330ffef772379a0169ddb9608"},
		{"runtime/requirements.txt", 115, "358bc104a02ea598f1e6cde8e7eeed169b9ec34f69f3543b47b390706446a1e0"},
		{"runtime/runtime.py", 10674, "30ad3905775040a8167360a009168b9ede1436cb02dc43e9e743432482eafbbf"},
		{"runtime/vision_artifact.py", 5285, "b3d9645300d913cc09abff04bf25f31621daac4d507e7e1a8b00a64442a05a3e"},
	},
}

// The tested native MLX dependency set from PrismML's Bonsai-demo
// (scripts/requirements-mlx-vlm.txt).
var mlxRequirements = []string{"mlx==0.32.3", "mlx-vlm==0.7.8", "mlx-lm==0.32.0", "transformers==5.19.0"}

const (
	mlxPython = "3.11"
	uvVersion = "0.13.3"
)

// PrismML's llama.cpp fork release pinned by Bonsai-demo; stock llama.cpp
// rejects PTQ1_0.
const llamaTag = "prism-b10787-73bfe6c"

func llamaURL(asset string) string {
	return fmt.Sprintf("https://github.com/PrismML-Eng/llama.cpp/releases/download/%s/%s", llamaTag, asset)
}

// Runtime archive sizes (bytes), for progress before headers arrive.
var llamaAssetSizes = map[string]int64{
	"llama-" + llamaTag + "-bin-macos-arm64.tar.gz":         11573797,
	"llama-" + llamaTag + "-bin-macos-x64.tar.gz":           11616912,
	"llama-" + llamaTag + "-bin-linux-cuda-12.4-x64.tar.gz": 327551187,
	"llama-" + llamaTag + "-bin-linux-cuda-12.8-x64.tar.gz": 208658605,
	"llama-" + llamaTag + "-bin-linux-cuda-13.3-x64.tar.gz": 184320718,
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-x64.tar.gz":   35952782,
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-arm64.tar.gz": 28382711,
	"llama-" + llamaTag + "-bin-ubuntu-x64.tar.gz":          17896259,
	"llama-" + llamaTag + "-bin-ubuntu-arm64.tar.gz":        13892127,
	"llama-" + llamaTag + "-bin-win-cuda-12.4-x64.zip":      314639598,
	"llama-" + llamaTag + "-bin-win-cuda-13.3-x64.zip":      179514746,
	"cudart-llama-bin-win-cuda-12.4-x64.zip":                391443627,
	"cudart-llama-bin-win-cuda-13.3-x64.zip":                390970417,
	"llama-" + llamaTag + "-bin-win-vulkan-x64.zip":         31308770,
	"llama-" + llamaTag + "-bin-win-cpu-x64.zip":            19539022,
	"llama-" + llamaTag + "-bin-win-cpu-arm64.zip":          12412126,
}

// SHA-256 digests published with the pinned PrismML release assets.
var llamaAssetSHA = map[string]string{
	"llama-" + llamaTag + "-bin-macos-arm64.tar.gz":         "59230b0d3e90715095a3f1b9a42bb6723308e7cf3d2d3ef562f49213e95fcfc1",
	"llama-" + llamaTag + "-bin-macos-x64.tar.gz":           "f7ade10b7367b9bc6c22f4890cf2b26702a40a1f4cd36dcdeca50663e4f0eff4",
	"llama-" + llamaTag + "-bin-linux-cuda-12.4-x64.tar.gz": "a7003184559fc946a0109734a9de8a1d53d5a6b33e308bec381a293b912f7093",
	"llama-" + llamaTag + "-bin-linux-cuda-12.8-x64.tar.gz": "f61ac818da2c8cddc47d75c955b6f5bf821738138760842dd50413c5181cdfe1",
	"llama-" + llamaTag + "-bin-linux-cuda-13.3-x64.tar.gz": "e2d492f50d70f3e01b4b3ae68f670ae6825870d97206fb1bcb5b4376640c0e0c",
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-x64.tar.gz":   "4401c665506927f5c2ad44c4e2e139715de5bd5e92b693a0a1f515b9442af9bb",
	"llama-" + llamaTag + "-bin-ubuntu-vulkan-arm64.tar.gz": "e7870fa961cb4344e601ad385dfd8fb141a827536963d64e4ee01e0e80dc99bc",
	"llama-" + llamaTag + "-bin-ubuntu-x64.tar.gz":          "bff69881bdb2b09dcbf5e99a1cb532b2a6821c6dc42d33ac53b2fa2cd3e6f214",
	"llama-" + llamaTag + "-bin-ubuntu-arm64.tar.gz":        "50171efa3706c4765e1948ccab840f7add207d9044c0978f9248c54054a01207",
	"llama-" + llamaTag + "-bin-win-cuda-12.4-x64.zip":      "64ca6810aae0e6bbb28d22f888bd009b9bdd0c24c5af8a6a7490b3eaf75ccd57",
	"llama-" + llamaTag + "-bin-win-cuda-13.3-x64.zip":      "20c45aecad3f4ede81c64ababc03f1dc10103fbd4cfb09244a16d21a3dd1db65",
	"cudart-llama-bin-win-cuda-12.4-x64.zip":                "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
	"cudart-llama-bin-win-cuda-13.3-x64.zip":                "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
	"llama-" + llamaTag + "-bin-win-vulkan-x64.zip":         "16d9482224e53d462eb210a766c8d94f0461cdca4d1c7263b2ba7b97092bf739",
	"llama-" + llamaTag + "-bin-win-cpu-x64.zip":            "ab1ea7cfc23fdac244088fd6f1762d0efa24d3d79fe18d4f16c496cc00775728",
	"llama-" + llamaTag + "-bin-win-cpu-arm64.zip":          "cc808b33d35c72a3bd5c69a0d609d422426feb9dce23868e77992b6c33b8ddb3",
}

var uvAssets = map[string]File{
	"uv-aarch64-apple-darwin.tar.gz": {Size: 14309841, SHA256: "bf1e4fb6f5f5079a2902ad3f3a9e2d337575b226a1378f2449d8404353650608"},
	"uv-x86_64-apple-darwin.tar.gz":  {Size: 17182824, SHA256: "5c35634957db7ebd9c2e4cc6c66b8979fb2c26a6b0dbd1d214d6acbac4033a89"},
}

func uvAsset(arch string) string {
	if arch == "arm64" {
		return "uv-aarch64-apple-darwin.tar.gz"
	}
	return "uv-x86_64-apple-darwin.tar.gz"
}

func uvURL(arch string) string {
	return fmt.Sprintf("https://github.com/astral-sh/uv/releases/download/%s/%s", uvVersion, uvAsset(arch))
}

const (
	gib = int64(1) << 30
	// FP16 KV cache per token on the 27B: 16 full-attention layers × K,V × 4
	// heads × 256 dims × 2 bytes. The 48 linear-attention layers keep a small
	// fixed recurrent state instead.
	kvBytesPerToken = 64 << 10
	// Compute buffers for batch prefill, measured loosely on llama.cpp.
	computeBytes = 900 << 20
	// The Q8_0 projector plus its working buffers when offloaded to the GPU
	// (Bonsai-demo: --no-mmproj-offload frees ~0.9 GiB of VRAM).
	visionGPUBytes = 960 << 20
	// The projector kept in system RAM (CPU image encoding).
	visionCPUBytes = 1300 << 20
	// Fixed recurrent state and runtime overhead.
	stateBytes = 300 << 20
)

// WBC_DEV_BONSAI_2B=1 swaps in the 2B GGUF pack (0.8 GB) so the install and
// serving pipeline can be exercised on small machines and in CI. It is not
// shown in the UI.
func init() {
	if os.Getenv("WBC_DEV_BONSAI_2B") == "" {
		return
	}
	gguf.Repo = "prism-ml/Ternary-Bonsai-2-2B-gguf"
	gguf.Rev = "683f7be2629342a50987627b40881e54761a2430"
	gguf.Model = File{"Ternary-Bonsai-2-2B-PTQ1_0.gguf", 429183456, "36061ad406df8a4903a6db005be350c50fabfaf717f9ef0acf4b76adcd9929fa"}
	gguf.Proj = File{"Ternary-Bonsai-2-2B-mmproj-Q8_0.gguf", 364664352, "ac9934e8d7966d0d62442c202ec8fdad99a045dea79366c1a4a246a46f5c0533"}
}
