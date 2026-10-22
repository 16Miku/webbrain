package d1

import "context"

// Engine is a loaded decision model, usable without the Manager (tests, tools).
type Engine struct{ e *engine }

// OpenEngine loads the graphs in dir with the ONNX Runtime library at lib.
func OpenEngine(dir, lib string, threads int) (*Engine, error) {
	e, err := loadEngine(dir, lib, threads)
	if err != nil {
		return nil, err
	}
	return &Engine{e: e}, nil
}

// EvaluateJSON answers one {state, images, questions} request body.
func (x *Engine) EvaluateJSON(ctx context.Context, body []byte) (any, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, err
	}
	return x.e.evaluate(ctx, req, ModelName)
}

// Encode exposes the prompt encoder for parity checks.
func (x *Engine) Encode(body []byte) ([][]int, [][]int, error) {
	req, err := parseRequest(body)
	if err != nil {
		return nil, nil, err
	}
	limit := min(x.e.cfg.MaxLength, cpuMaxTextTokens)
	if len(req.images) > 0 {
		limit = x.e.cfg.ImageTextLength
	}
	var ids, markers [][]int
	for _, q := range req.questions {
		enc, err := encode(x.e.tok, req.stateText, q, limit, len(req.images) > 0)
		if err != nil {
			return nil, nil, err
		}
		ids = append(ids, enc.ids)
		markers = append(markers, enc.markers)
	}
	return ids, markers, nil
}

func (x *Engine) Close() { x.e.close() }
