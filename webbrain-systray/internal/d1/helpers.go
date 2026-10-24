package d1

import "github.com/esokullu/webbrain-systray/internal/osutil"

func execQuiet(name string, args ...string) error {
	return osutil.Command(name, args...).Run()
}

// SHA-256 of the pinned ONNX Runtime 1.31.0 release archives.
var ortSHA = map[string]string{
	"linux-x64":     "cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57",
	"linux-aarch64": "c5b8b3cca31f3d643a3b313b8f42e2d0f16a4fcefd02cda343d97bd5306afaab",
	"osx-arm64":     "1031b36dd3bdaa8d976a6130d9cf2a05e9be320b93ae804f8427b91dc3432afc",
	"win-x64":       "3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195",
	"win-arm64":     "ef6206fa8d6975878d93a97035d280240ce5764c126a7430e5427e18923316d5",
}
