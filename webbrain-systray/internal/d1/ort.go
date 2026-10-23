package d1

// A minimal ONNX Runtime binding over the C API, loaded at runtime with
// purego (no cgo). Function pointers are read from the OrtApi table; the
// indices below come from onnxruntime_c_api.h (the table is append-only, so
// they are stable across ORT releases).

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"unicode/utf16"
	"unsafe"

	"github.com/ebitengine/purego"
)

const ortRequestedAPIVersion = 20

const (
	fnGetErrorMessage                = 2
	fnCreateEnv                      = 3
	fnCreateSession                  = 7
	fnRun                            = 9
	fnCreateSessionOptions           = 10
	fnSetSessionGraphOptimization    = 23
	fnSetIntraOpNumThreads           = 24
	fnSetInterOpNumThreads           = 25
	fnSessionGetInputCount           = 30
	fnSessionGetOutputCount          = 31
	fnSessionGetInputName            = 36
	fnSessionGetOutputName           = 37
	fnCreateTensorWithDataAsOrtValue = 49
	fnGetTensorMutableData           = 51
	fnGetDimensionsCount             = 61
	fnGetDimensions                  = 62
	fnGetTensorShapeElementCount     = 64
	fnGetTensorTypeAndShape          = 65
	fnCreateCpuMemoryInfo            = 69
	fnAllocatorFree                  = 76
	fnGetAllocatorWithDefaultOptions = 78
	fnReleaseEnv                     = 92
	fnReleaseStatus                  = 93
	fnReleaseMemoryInfo              = 94
	fnReleaseSession                 = 95
	fnReleaseValue                   = 96
	fnReleaseTensorTypeAndShapeInfo  = 99
	fnReleaseSessionOptions          = 100
)

// ONNX tensor element types.
const (
	elemFloat = 1
	elemInt64 = 7
	elemBool  = 9
)

type ortLib struct {
	api     uintptr
	env     uintptr
	memInfo uintptr
	alloc   uintptr
	version string
}

// cptr turns an address owned by C into a pointer (C memory never moves).
func cptr(p uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&p)) }

func (o *ortLib) fn(idx int) uintptr {
	return *(*uintptr)(unsafe.Add(cptr(o.api), idx*int(unsafe.Sizeof(uintptr(0)))))
}

func (o *ortLib) call(idx int, args ...uintptr) uintptr {
	r, _, _ := purego.SyscallN(o.fn(idx), args...)
	return r
}

// check converts an OrtStatus* into an error and releases it.
func (o *ortLib) check(status uintptr) error {
	if status == 0 {
		return nil
	}
	msg := goString(o.call(fnGetErrorMessage, status))
	o.call(fnReleaseStatus, status)
	return errors.New("onnxruntime: " + msg)
}

func goString(p uintptr) string {
	if p == 0 {
		return ""
	}
	var b []byte
	for i := 0; i < 1<<16; i++ {
		c := *(*byte)(unsafe.Add(cptr(p), i))
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

func cString(s string) []byte { return append([]byte(s), 0) }

// ortPath encodes a filesystem path as ORTCHAR_T* (UTF-16 on Windows).
func ortPath(p string) (uintptr, any) {
	if runtime.GOOS == "windows" {
		u := append(utf16.Encode([]rune(p)), 0)
		return uintptr(unsafe.Pointer(&u[0])), u
	}
	b := cString(p)
	return uintptr(unsafe.Pointer(&b[0])), b
}

var (
	ortOnce sync.Mutex
	ortInst *ortLib
)

// loadORT opens the ONNX Runtime shared library and creates the environment.
func loadORT(libPath string) (*ortLib, error) {
	ortOnce.Lock()
	defer ortOnce.Unlock()
	if ortInst != nil {
		return ortInst, nil
	}
	sym, err := openSymbol(libPath, "OrtGetApiBase")
	if err != nil {
		return nil, err
	}
	base, _, _ := purego.SyscallN(sym)
	if base == 0 {
		return nil, errors.New("OrtGetApiBase returned null")
	}
	getAPI := *(*uintptr)(cptr(base))
	getVersion := *(*uintptr)(unsafe.Add(cptr(base), unsafe.Sizeof(uintptr(0))))
	api, _, _ := purego.SyscallN(getAPI, ortRequestedAPIVersion)
	if api == 0 {
		return nil, fmt.Errorf("ONNX Runtime at %s does not support API version %d", libPath, ortRequestedAPIVersion)
	}
	vp, _, _ := purego.SyscallN(getVersion)
	o := &ortLib{api: api, version: goString(vp)}
	logid := cString("webbrain-d1")
	var env uintptr
	if err := o.check(o.call(fnCreateEnv, 3 /* ERROR */, uintptr(unsafe.Pointer(&logid[0])), uintptr(unsafe.Pointer(&env)))); err != nil {
		return nil, err
	}
	runtime.KeepAlive(logid)
	o.env = env
	var mi uintptr
	if err := o.check(o.call(fnCreateCpuMemoryInfo, 1 /* arena */, 0 /* default */, uintptr(unsafe.Pointer(&mi)))); err != nil {
		return nil, err
	}
	o.memInfo = mi
	var alloc uintptr
	if err := o.check(o.call(fnGetAllocatorWithDefaultOptions, uintptr(unsafe.Pointer(&alloc)))); err != nil {
		return nil, err
	}
	o.alloc = alloc
	ortInst = o
	return o, nil
}

type session struct {
	o       *ortLib
	ptr     uintptr
	inputs  []string
	outputs []string
}

func (o *ortLib) newSession(modelPath string, threads int) (*session, error) {
	var opts uintptr
	if err := o.check(o.call(fnCreateSessionOptions, uintptr(unsafe.Pointer(&opts)))); err != nil {
		return nil, err
	}
	defer o.call(fnReleaseSessionOptions, opts)
	if threads > 0 {
		if err := o.check(o.call(fnSetIntraOpNumThreads, opts, uintptr(threads))); err != nil {
			return nil, err
		}
	}
	if err := o.check(o.call(fnSetInterOpNumThreads, opts, 1)); err != nil {
		return nil, err
	}
	// ORT_ENABLE_EXTENDED: fusions without layout transforms.
	if err := o.check(o.call(fnSetSessionGraphOptimization, opts, 2)); err != nil {
		return nil, err
	}
	p, keep := ortPath(modelPath)
	var s uintptr
	err := o.check(o.call(fnCreateSession, o.env, p, opts, uintptr(unsafe.Pointer(&s))))
	runtime.KeepAlive(keep)
	if err != nil {
		return nil, err
	}
	sess := &session{o: o, ptr: s}
	var n uintptr
	if err := o.check(o.call(fnSessionGetInputCount, s, uintptr(unsafe.Pointer(&n)))); err != nil {
		return nil, err
	}
	for i := uintptr(0); i < n; i++ {
		var name uintptr
		if err := o.check(o.call(fnSessionGetInputName, s, i, o.alloc, uintptr(unsafe.Pointer(&name)))); err != nil {
			return nil, err
		}
		sess.inputs = append(sess.inputs, goString(name))
		o.call(fnAllocatorFree, o.alloc, name)
	}
	if err := o.check(o.call(fnSessionGetOutputCount, s, uintptr(unsafe.Pointer(&n)))); err != nil {
		return nil, err
	}
	for i := uintptr(0); i < n; i++ {
		var name uintptr
		if err := o.check(o.call(fnSessionGetOutputName, s, i, o.alloc, uintptr(unsafe.Pointer(&name)))); err != nil {
			return nil, err
		}
		sess.outputs = append(sess.outputs, goString(name))
		o.call(fnAllocatorFree, o.alloc, name)
	}
	return sess, nil
}

func (s *session) release() {
	if s != nil && s.ptr != 0 {
		s.o.call(fnReleaseSession, s.ptr)
		s.ptr = 0
	}
}

// tensor is an input whose bytes stay owned by Go until the run returns.
type tensor struct {
	elem  int
	shape []int64
	data  unsafe.Pointer
	bytes uintptr
	keep  any
}

func floatTensor(data []float32, shape ...int64) tensor {
	var dummy [1]float32
	p := unsafe.Pointer(&dummy[0])
	if len(data) > 0 {
		p = unsafe.Pointer(&data[0])
	}
	return tensor{elemFloat, shape, p, uintptr(len(data) * 4), [2]any{data, &dummy}}
}

func int64Tensor(data []int64, shape ...int64) tensor {
	var dummy [1]int64
	p := unsafe.Pointer(&dummy[0])
	if len(data) > 0 {
		p = unsafe.Pointer(&data[0])
	}
	return tensor{elemInt64, shape, p, uintptr(len(data) * 8), [2]any{data, &dummy}}
}

func boolTensor(data []bool, shape ...int64) tensor {
	var dummy [1]bool
	p := unsafe.Pointer(&dummy[0])
	if len(data) > 0 {
		p = unsafe.Pointer(&data[0])
	}
	return tensor{elemBool, shape, p, uintptr(len(data)), [2]any{data, &dummy}}
}

// output is a float32 result copied out of ORT memory.
type output struct {
	data  []float32
	shape []int64
}

// run feeds named inputs and returns the requested float outputs.
func (s *session) run(inputs map[string]tensor, outputs ...string) (map[string]output, error) {
	o := s.o
	names := make([][]byte, 0, len(inputs))
	namePtrs := make([]uintptr, 0, len(inputs))
	values := make([]uintptr, 0, len(inputs))
	keep := make([]any, 0, len(inputs))
	defer func() {
		for _, v := range values {
			o.call(fnReleaseValue, v)
		}
		runtime.KeepAlive(keep)
		runtime.KeepAlive(names)
	}()
	for _, name := range s.inputs {
		t, ok := inputs[name]
		if !ok {
			return nil, fmt.Errorf("missing input %q", name)
		}
		var v uintptr
		shape := t.shape
		if len(shape) == 0 {
			shape = []int64{}
		}
		var shapePtr uintptr
		if len(shape) > 0 {
			shapePtr = uintptr(unsafe.Pointer(&shape[0]))
		}
		err := o.check(o.call(fnCreateTensorWithDataAsOrtValue, o.memInfo, uintptr(t.data), t.bytes,
			shapePtr, uintptr(len(shape)), uintptr(t.elem), uintptr(unsafe.Pointer(&v))))
		keep = append(keep, t.keep, shape)
		if err != nil {
			return nil, fmt.Errorf("input %s: %w", name, err)
		}
		values = append(values, v)
		n := cString(name)
		names = append(names, n)
		namePtrs = append(namePtrs, uintptr(unsafe.Pointer(&n[0])))
	}
	outNames := make([][]byte, len(outputs))
	outPtrs := make([]uintptr, len(outputs))
	for i, n := range outputs {
		outNames[i] = cString(n)
		outPtrs[i] = uintptr(unsafe.Pointer(&outNames[i][0]))
	}
	outVals := make([]uintptr, len(outputs))
	var inPtr, valPtr uintptr
	if len(namePtrs) > 0 {
		inPtr, valPtr = uintptr(unsafe.Pointer(&namePtrs[0])), uintptr(unsafe.Pointer(&values[0]))
	}
	err := o.check(o.call(fnRun, s.ptr, 0, inPtr, valPtr, uintptr(len(values)),
		uintptr(unsafe.Pointer(&outPtrs[0])), uintptr(len(outputs)), uintptr(unsafe.Pointer(&outVals[0]))))
	runtime.KeepAlive(namePtrs)
	runtime.KeepAlive(outNames)
	runtime.KeepAlive(outPtrs)
	if err != nil {
		for _, v := range outVals {
			if v != 0 {
				o.call(fnReleaseValue, v)
			}
		}
		return nil, err
	}
	res := make(map[string]output, len(outputs))
	for i, name := range outputs {
		v := outVals[i]
		out, err := o.readFloat(v)
		o.call(fnReleaseValue, v)
		if err != nil {
			return nil, fmt.Errorf("output %s: %w", name, err)
		}
		res[name] = out
	}
	return res, nil
}

func (o *ortLib) readFloat(v uintptr) (output, error) {
	var info uintptr
	if err := o.check(o.call(fnGetTensorTypeAndShape, v, uintptr(unsafe.Pointer(&info)))); err != nil {
		return output{}, err
	}
	defer o.call(fnReleaseTensorTypeAndShapeInfo, info)
	var dims uintptr
	if err := o.check(o.call(fnGetDimensionsCount, info, uintptr(unsafe.Pointer(&dims)))); err != nil {
		return output{}, err
	}
	shape := make([]int64, dims)
	if dims > 0 {
		if err := o.check(o.call(fnGetDimensions, info, uintptr(unsafe.Pointer(&shape[0])), dims)); err != nil {
			return output{}, err
		}
	}
	var count uintptr
	if err := o.check(o.call(fnGetTensorShapeElementCount, info, uintptr(unsafe.Pointer(&count)))); err != nil {
		return output{}, err
	}
	var p uintptr
	if err := o.check(o.call(fnGetTensorMutableData, v, uintptr(unsafe.Pointer(&p)))); err != nil {
		return output{}, err
	}
	data := make([]float32, count)
	if count > 0 && p != 0 {
		copy(data, unsafe.Slice((*float32)(cptr(p)), count))
	}
	return output{data: data, shape: shape}, nil
}
