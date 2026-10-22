package d1

// Port of WebBrain's d1-preprocess.js (the package's FP32 adapter helper):
// prompt rendering, token budgets, temperatures and the exact image
// pipeline (Torch-style fixed-point antialias resize, 16×16 patches,
// interpolated position matrices).

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"regexp"
	"strings"

	_ "golang.org/x/image/webp"
)

type Question struct {
	ID           string
	Type         string
	Instructions string
	Criteria     *Value
}

var specialRe = regexp.MustCompile(`<\|([A-Za-z0-9_]+)\|>`)

// escapeSpecial neutralises special-token spellings inside user text.
func escapeSpecial(s string) string {
	return specialRe.ReplaceAllString(s, "<¦$1¦>")
}

func criterion(v *Value) (string, error) {
	if v != nil && v.K == kStr {
		return v.S, nil
	}
	return pyJSON(v)
}

// empty mirrors JS `v == null || v === ”`.
func emptyCrit(v *Value) bool {
	return v == nil || v.K == kNull || (v.K == kStr && v.S == "")
}

func renderOptions(q Question, image bool) ([]string, error) {
	switch q.Type {
	case "choice":
		var out []string
		for _, k := range q.Criteria.Keys {
			v := q.Criteria.M[k]
			if emptyCrit(v) {
				out = append(out, k)
				continue
			}
			c, err := criterion(v)
			if err != nil {
				return nil, err
			}
			out = append(out, k+": "+c)
		}
		return out, nil
	case "score":
		var out []string
		for i, v := range q.Criteria.A {
			c, err := criterion(v)
			if err != nil {
				return nil, err
			}
			out = append(out, fmt.Sprintf("level %d: %s", i, c))
		}
		return out, nil
	}
	// noul
	c := q.Criteria
	if c == nil || c.K != kObj || len(c.Keys) == 0 {
		if image {
			c = &Value{K: kObj, Keys: []string{"false", "true"}, M: map[string]*Value{
				"false": {K: kStr, S: "no"}, "true": {K: kStr, S: "yes"}}}
		} else {
			c = &Value{K: kObj, M: map[string]*Value{}}
		}
	}
	var no, yes *Value
	if c.Has("false") {
		no = c.Get("false")
	} else {
		no = c.Get("no")
	}
	if c.Has("true") {
		yes = c.Get("true")
	} else {
		yes = c.Get("yes")
	}
	noText, yesText := "no, the statement does not hold", "yes, the statement holds"
	if !emptyCrit(no) {
		s, err := criterion(no)
		if err != nil {
			return nil, err
		}
		noText = s
	}
	if !emptyCrit(yes) {
		s, err := criterion(yes)
		if err != nil {
			return nil, err
		}
		yesText = s
	}
	return []string{"false: " + noText, "true: " + yesText}, nil
}

func validateQuestion(q Question) error {
	switch q.Type {
	case "choice", "noul", "score":
	default:
		return errors.New("Invalid question type or instructions")
	}
	if q.Type == "choice" && (q.Criteria == nil || q.Criteria.K != kObj || len(q.Criteria.Keys) < 2) {
		return errors.New("A choice requires at least two named criteria")
	}
	if q.Type == "score" && (q.Criteria == nil || q.Criteria.K != kArr || len(q.Criteria.A) < 2 || len(q.Criteria.A) > 10) {
		return errors.New("A score requires 2 to 10 levels")
	}
	if q.Type == "noul" && q.Criteria != nil && q.Criteria.K != kNull && q.Criteria.K != kObj {
		return errors.New("noul criteria must be an object")
	}
	return nil
}

type encoded struct {
	ids     []int
	markers []int
}

func clampSlice(ids []int, n int) []int {
	if n < 0 {
		n = 0
	}
	if len(ids) > n {
		return ids[:n]
	}
	return ids
}

// encode builds one question row: BOS, state, question, option markers.
func encode(t *Tokenizer, state string, q Question, maxLen int, image bool) (encoded, error) {
	if err := validateQuestion(q); err != nil {
		return encoded{}, err
	}
	enc := func(s string) []int { return t.Encode(escapeSpecial(s)) }
	options, err := renderOptions(q, image)
	if err != nil {
		return encoded{}, err
	}
	n := len(options)
	budget := max(96, min(n*24+32, maxLen/2))
	per := max(2, int(math.Floor(float64(budget-3*n)/float64(n))))
	question := append([]int{t.ID("<|reserved_8|>")}, enc(q.Instructions)...)
	question = clampSlice(question, max(16, budget))
	question = append([]int(nil), question...)
	var markers []int
	for _, opt := range options {
		markers = append(markers, len(question)+1)
		question = append(question, t.ID("<|reserved_9|>"), t.ID("<|mask|>"))
		question = append(question, clampSlice(enc(" "+opt), per)...)
		question = append(question, t.ID("<|reserved_10|>"))
	}
	question = append(question, t.ID("<|reserved_11|>"))
	room := max(0, maxLen-len(question)-2)
	stateIDs := append([]int{t.ID("<|reserved_7|>")}, clampSlice(enc(state), room)...)
	ids := append([]int{t.BosID}, stateIDs...)
	ids = append(ids, question...)
	ids = clampSlice(ids, maxLen)
	pos := make([]int, len(markers))
	for i, m := range markers {
		pos[i] = m + 1 + len(stateIDs)
	}
	if len(pos) > 0 && pos[len(pos)-1] >= maxLen {
		return encoded{}, errors.New("Options do not fit in context")
	}
	return encoded{ids: ids, markers: pos}, nil
}

func questionTemperature(q Question, temps map[string]float64, image bool) float32 {
	if image {
		return 1
	}
	n := 2
	if q.Type != "noul" {
		n = q.Criteria.Len()
	}
	bucket := "11+"
	switch {
	case n <= 2:
		bucket = "2"
	case n <= 5:
		bucket = "3-5"
	case n <= 10:
		bucket = "6-10"
	}
	if v, ok := temps[q.Type+":"+bucket]; ok {
		return float32(v)
	}
	if v, ok := temps[q.Type]; ok {
		return float32(v)
	}
	return 1
}

// --- images -------------------------------------------------------------------

func roundEven(x float64) float64 {
	n := math.Floor(x)
	if x-n == 0.5 {
		return n + math.Mod(n, 2)
	}
	return math.Floor(x + 0.5) // JS Math.round
}

type imagePlan struct {
	Grid      [2]int `json:"grid"`
	Thumbnail [2]int `json:"thumbnail"` // h, w
	Tiled     bool   `json:"tiled"`
}

func layout(width, height int, ratios [][2]int) (imagePlan, error) {
	if min(width, height) < 1 {
		return imagePlan{}, errors.New("Empty image")
	}
	W, H := float64(width), float64(height)
	h := math.Max(32, roundEven(H/32)*32)
	w := math.Max(32, roundEven(W/32)*32)
	if h*w > 262144 {
		beta := math.Sqrt(H * W / 262144)
		h = math.Max(32, math.Floor(H/beta/32)*32)
		w = math.Max(32, math.Floor(W/beta/32)*32)
	} else if h*w < 65536 {
		beta := math.Sqrt(65536 / (H * W))
		h = math.Ceil(H*beta/32) * 32
		w = math.Ceil(W*beta/32) * 32
	}
	tiled := math.Max(16, roundEven(H/32)*32)*math.Max(16, roundEven(W/32)*32) > 524288
	plan := imagePlan{Grid: [2]int{1, 1}, Thumbnail: [2]int{int(h), int(w)}, Tiled: tiled}
	if tiled {
		best := math.Inf(1)
		for _, r := range ratios {
			diff := math.Abs(W/H - float64(r[0])/float64(r[1]))
			if diff < best || (diff == best && W*H > 0.5*512*512*float64(r[0])*float64(r[1])) {
				plan.Grid = r
				best = diff
			}
		}
	}
	return plan, nil
}

type weightRow struct {
	start   int
	weights []int64
}

func resizeWeights(input, output int) ([]weightRow, int64) {
	scale := float64(input) / float64(output)
	support := math.Max(1, scale)
	rows := make([]weightRow, output)
	largest := 0.0
	fw := make([][]float64, output)
	for i := 0; i < output; i++ {
		center := scale * (float64(i) + 0.5)
		start := max(0, int(math.Trunc(center-support+0.5)))
		end := min(input, int(math.Trunc(center+support+0.5)))
		ws := make([]float64, end-start)
		total := 0.0
		for j := range ws {
			ws[j] = math.Max(0, 1-math.Abs((float64(j+start)-center+0.5)/support))
			total += ws[j]
		}
		for j := range ws {
			ws[j] /= total
			largest = math.Max(largest, ws[j])
		}
		fw[i] = ws
		rows[i].start = start
	}
	precision := 0
	for ; precision < 22; precision++ {
		if math.Trunc(0.5+largest*math.Pow(2, float64(precision+1))) >= 32768 {
			break
		}
	}
	unit := math.Pow(2, float64(precision))
	for i := range rows {
		rows[i].weights = make([]int64, len(fw[i]))
		for j, w := range fw[i] {
			rows[i].weights[j] = int64(math.Trunc(0.5 + w*unit))
		}
	}
	return rows, int64(unit)
}

// resizeRGB is Torch's uint8 antialias bilinear resize (two rounded passes).
func resizeRGB(rgb []byte, width, height, newWidth, newHeight int) []byte {
	temp := rgb
	if width != newWidth {
		rows, unit := resizeWeights(width, newWidth)
		temp = make([]byte, newWidth*height*3)
		for y := 0; y < height; y++ {
			for x := 0; x < newWidth; x++ {
				row := rows[x]
				for c := 0; c < 3; c++ {
					sum := unit / 2
					for j, w := range row.weights {
						sum += int64(rgb[(y*width+row.start+j)*3+c]) * w
					}
					temp[(y*newWidth+x)*3+c] = clamp8(floorDiv(sum, unit))
				}
			}
		}
	}
	if height == newHeight {
		return temp
	}
	rows, unit := resizeWeights(height, newHeight)
	out := make([]byte, newWidth*newHeight*3)
	for y := 0; y < newHeight; y++ {
		row := rows[y]
		for x := 0; x < newWidth; x++ {
			for c := 0; c < 3; c++ {
				sum := unit / 2
				for j, w := range row.weights {
					sum += int64(temp[((row.start+j)*newWidth+x)*3+c]) * w
				}
				out[(y*newWidth+x)*3+c] = clamp8(floorDiv(sum, unit))
			}
		}
	}
	return out
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

func clamp8(v int64) byte {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return byte(v)
}

var dataURLRe = regexp.MustCompile(`^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$`)

// decodeRGB decodes an inline image to 8-bit RGB the way a canvas read-back
// does (no colour management; alpha un-premultiplied).
func decodeRGB(url string) ([]byte, int, int, error) {
	if !dataURLRe.MatchString(url) {
		return nil, 0, 0, errors.New("D1 accepts at most four inline PNG/JPEG/WebP screenshots; remote image URLs are not allowed.")
	}
	raw, err := base64.StdEncoding.DecodeString(url[strings.Index(url, ",")+1:])
	if err != nil {
		return nil, 0, 0, fmt.Errorf("invalid base64 image: %w", err)
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("could not decode image: %w", err)
	}
	if err := checkImageSize(cfg.Width, cfg.Height); err != nil {
		return nil, 0, 0, err
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("could not decode image: %w", err)
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if err := checkImageSize(w, h); err != nil {
		return nil, 0, 0, err
	}
	rgb := make([]byte, w*h*3)
	switch src := img.(type) {
	case *image.NRGBA:
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				i := src.PixOffset(b.Min.X+x, b.Min.Y+y)
				r, g, bl, a := src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3]
				o := (y*w + x) * 3
				rgb[o], rgb[o+1], rgb[o+2] = unpremul(r, a), unpremul(g, a), unpremul(bl, a)
			}
		}
	default:
		nrgba := image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.Draw(nrgba, nrgba.Bounds(), img, b.Min, draw.Src)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				c := nrgba.NRGBAAt(x, y)
				o := (y*w + x) * 3
				rgb[o], rgb[o+1], rgb[o+2] = unpremul(c.R, c.A), unpremul(c.G, c.A), unpremul(c.B, c.A)
			}
		}
	}
	_ = color.NRGBA{}
	return rgb, w, h, nil
}

func checkImageSize(width, height int) error {
	if width < 1 || height < 1 {
		return errors.New("Empty image")
	}
	// Division keeps malformed dimensions from overflowing the pixel count.
	if width > 40_000_000/height {
		return errors.New("image is too large")
	}
	return nil
}

// unpremul models a canvas round-trip through premultiplied storage.
func unpremul(c, a uint8) uint8 {
	switch a {
	case 255:
		return c
	case 0:
		return 0
	}
	pm := (uint32(c)*uint32(a) + 127) / 255
	v := (pm*255 + uint32(a)/2) / uint32(a)
	if v > 255 {
		v = 255
	}
	return uint8(v)
}

type imageInput struct {
	plan   imagePlan
	pixels []float32
	mask   []bool
	shapes [][2]int // patch grid (h, w) per crop
}

func imageInputs(url string, ratios [][2]int) (imageInput, error) {
	rgb, width, height, err := decodeRGB(url)
	if err != nil {
		return imageInput{}, err
	}
	plan, err := layout(width, height, ratios)
	if err != nil {
		return imageInput{}, err
	}
	th, tw := plan.Thumbnail[0], plan.Thumbnail[1]
	// Extreme aspect ratios can exceed the patch budget after the minimum
	// thumbnail dimension is applied. Reject them before resizing or packing.
	if th < 16 || tw < 16 || th/16 > patches/(tw/16) {
		return imageInput{}, errors.New("image aspect ratio exceeds the model's patch limit")
	}
	type crop struct {
		rgb  []byte
		h, w int
	}
	var crops []crop
	if plan.Tiled {
		gw, gh := plan.Grid[0], plan.Grid[1]
		big := resizeRGB(rgb, width, height, gw*512, gh*512)
		for r := 0; r < gh; r++ {
			for c := 0; c < gw; c++ {
				px := make([]byte, 512*512*3)
				for y := 0; y < 512; y++ {
					src := ((r*512+y)*gw*512 + c*512) * 3
					copy(px[y*512*3:(y+1)*512*3], big[src:src+512*3])
				}
				crops = append(crops, crop{px, 512, 512})
			}
		}
	}
	crops = append(crops, crop{resizeRGB(rgb, width, height, tw, th), th, tw})
	in := imageInput{plan: plan, pixels: make([]float32, len(crops)*1024*768), mask: make([]bool, len(crops)*1024)}
	for i, cr := range crops {
		ph, pw := cr.h/16, cr.w/16
		in.shapes = append(in.shapes, [2]int{ph, pw})
		for k := 0; k < ph*pw; k++ {
			in.mask[i*1024+k] = true
		}
		for r := 0; r < ph; r++ {
			for c := 0; c < pw; c++ {
				base := (i*1024 + r*pw + c) * 768
				for y := 0; y < 16; y++ {
					for x := 0; x < 16; x++ {
						src := ((r*16+y)*cr.w + c*16 + x) * 3
						dst := base + (y*16+x)*3
						for ch := 0; ch < 3; ch++ {
							v := float64(cr.rgb[src+ch])
							in.pixels[dst+ch] = float32(float64(float32(v-127.5)) / 127.5)
						}
					}
				}
			}
		}
	}
	return in, nil
}

// positionMatrix interpolates the 16×16 learned position grid to h×w patches
// (float32 arithmetic, as the adapter's Math.fround chain).
func positionMatrix(h, w int) []float32 {
	matrix := make([]float32, 1024*256)
	type wv struct {
		j int
		v float32
	}
	weights := func(input, output int) [][]wv {
		out := make([][]wv, output)
		for i := 0; i < output; i++ {
			scale := float32(float64(input) / float64(output))
			support := float32(math.Max(1, float64(scale)))
			center := float32(float64(scale) * float64(float32(float64(i)+0.5)))
			start := max(0, int(math.Trunc(float64(float32(float64(float32(float64(center)-float64(support)))+0.5)))))
			end := min(input, int(math.Trunc(float64(float32(float64(float32(float64(center)+float64(support)))+0.5)))))
			inv := float32(1)
			if scale >= 1 {
				inv = float32(1 / float64(scale))
			}
			var a []wv
			sum := float32(0)
			for j := start; j < end; j++ {
				d := float32(float64(j) - float64(center))
				d = float32(float64(d) + 0.5)
				d = float32(float64(d) * float64(inv))
				v := float32(1 - math.Abs(float64(d)))
				v = float32(math.Max(0, float64(v)))
				a = append(a, wv{j, v})
				sum = float32(float64(sum) + float64(v))
			}
			for k := range a {
				a[k].v = float32(float64(a[k].v) / float64(sum))
			}
			out[i] = a
		}
		return out
	}
	wy, wx := weights(16, h), weights(16, w)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			row := (y*w + x) * 256
			for _, a := range wy[y] {
				for _, b := range wx[x] {
					matrix[row+a.j*16+b.j] = float32(float64(a.v) * float64(b.v))
				}
			}
		}
	}
	for i := h * w; i < 1024; i++ {
		copy(matrix[i*256:(i+1)*256], matrix[0:256])
	}
	return matrix
}
