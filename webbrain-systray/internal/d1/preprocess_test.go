package d1

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestDecodeRGBRejectsOversizedHeaderBeforePixels(t *testing.T) {
	// A valid IHDR with no pixel stream: rejection must happen from dimensions,
	// before the decoder attempts to allocate or read the oversized image.
	raw := make([]byte, 33)
	copy(raw, "\x89PNG\r\n\x1a\n")
	binary.BigEndian.PutUint32(raw[8:12], 13)
	copy(raw[12:16], "IHDR")
	binary.BigEndian.PutUint32(raw[16:20], 100_000)
	binary.BigEndian.PutUint32(raw[20:24], 100_000)
	raw[24], raw[25] = 8, 2
	binary.BigEndian.PutUint32(raw[29:33], crc32.ChecksumIEEE(raw[12:29]))
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
	if _, _, _, err := decodeRGB(url); err == nil || err.Error() != "image is too large" {
		t.Fatalf("decodeRGB oversized header: got %v, want image is too large", err)
	}
}

func TestDecodeRGBValidPNG(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 2, 1))
	img.SetNRGBA(0, 0, color.NRGBA{R: 12, G: 34, B: 56, A: 255})
	img.SetNRGBA(1, 0, color.NRGBA{R: 78, G: 90, B: 123, A: 255})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
	rgb, width, height, err := decodeRGB(url)
	if err != nil {
		t.Fatal(err)
	}
	if width != 2 || height != 1 || !bytes.Equal(rgb, []byte{12, 34, 56, 78, 90, 123}) {
		t.Fatalf("decodeRGB: got %dx%d %v", width, height, rgb)
	}
}

func TestImageInputsRejectsExtremeAspectRatio(t *testing.T) {
	for _, size := range [][2]int{{10_000, 1}, {1, 10_000}} {
		t.Run(fmt.Sprintf("%dx%d", size[0], size[1]), func(t *testing.T) {
			img := image.NewGray(image.Rect(0, 0, size[0], size[1]))
			var encoded bytes.Buffer
			if err := png.Encode(&encoded, img); err != nil {
				t.Fatal(err)
			}
			url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
			if _, err := imageInputs(url, nil); err == nil || err.Error() != "image aspect ratio exceeds the model's patch limit" {
				t.Fatalf("imageInputs extreme aspect ratio: got %v, want patch limit error", err)
			}
		})
	}
}

func TestImageInputsAcceptsNormalImage(t *testing.T) {
	img := image.NewGray(image.Rect(0, 0, 512, 512))
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, img); err != nil {
		t.Fatal(err)
	}
	url := "data:image/png;base64," + base64.StdEncoding.EncodeToString(encoded.Bytes())
	input, err := imageInputs(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(input.shapes) != 1 || input.shapes[0] != [2]int{32, 32} || len(input.mask) != patches {
		t.Fatalf("unexpected image input shapes %v, mask size %d", input.shapes, len(input.mask))
	}
}
