"""Train tiny Ask's screenshot gate probe for an in-browser model that reads
images (Ternary Bonsai 2 2B Vision, Compass VLD Tiny v5).

Inputs are reports from scripts/check-tiny-ask-screenshot-gate.mjs run with
`--dataset <split>.json --return-hidden` on the splits written by
gate_dataset.py: one Yes-minus-No margin and one last-position hidden state
per question. The backbone stays frozen; a logistic regression on
[margin, standardized hidden] gives p(needs a screenshot). The L2 strength is
chosen on validation and the test split is scored once. The test split holds
hand-written questions, including languages absent from training.

    python scripts/models/bonsai/train_gate_probe.py --reports <dir> --out <dir> --js src/chrome/src/offscreen/tiny-ask-gate-probe.js

--model and --export name the model and its probe in that file (default
Ternary Bonsai 2 2B Vision, TINY_ASK_GATE_PROBE; Compass VLD Tiny v5 is
COMPASS_VLD_TINY_ASK_GATE_PROBE).
"""
import argparse
import base64
import json
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

TRAIN_LANGUAGES = {'en', 'tr', 'de', 'es', 'fr', 'it', 'pt', 'ru', 'ja', 'zh', 'ar'}


def decode(text):
    return np.frombuffer(base64.b64decode(text), dtype=np.float16).astype(np.float64)


def load(path):
    report = json.loads(Path(path).read_text(encoding='utf-8'))
    rows = [report['cold'], *report['cases']]
    rows = [row for row in rows if row and row.get('hidden') and row.get('margin') is not None]
    x_margin = np.array([row['margin'] for row in rows], dtype=np.float64)
    x_hidden = np.stack([decode(row['hidden']) for row in rows])
    y = np.array([1.0 if row['expected'] else 0.0 for row in rows])
    return rows, x_margin, x_hidden, y


def unpack(params, width):
    return params[0], params[1:1 + width], params[1 + width]


def objective(params, margin, z, y, l2):
    width = z.shape[1]
    a, w, b = unpack(params, width)
    logits = a * margin + z @ w + b
    p = 1 / (1 + np.exp(-logits))
    eps = 1e-9
    loss = -np.mean(y * np.log(p + eps) + (1 - y) * np.log(1 - p + eps)) + l2 * np.sum(w ** 2)
    d = (p - y) / len(y)
    grad = np.concatenate([[d @ margin], z.T @ d + 2 * l2 * w, [d.sum()]])
    return loss, grad


def predict(params, margin, z):
    a, w, b = unpack(params, z.shape[1])
    return 1 / (1 + np.exp(-(a * margin + z @ w + b)))


def metrics(rows, p, y, threshold=0.5):
    guess = p >= threshold
    out = {
        'accuracy': f'{int((guess == (y == 1)).sum())}/{len(y)}',
        'yes_recall': f'{int((guess & (y == 1)).sum())}/{int((y == 1).sum())}',
        'false_yes': f'{int((guess & (y == 0)).sum())}/{int((y == 0).sum())}',
        'nll': float(-np.mean(y * np.log(p + 1e-9) + (1 - y) * np.log(1 - p + 1e-9))),
    }
    languages = sorted({row['language'] for row in rows})
    out['by_language'] = {lang: f'{sum(1 for row, g, t in zip(rows, guess, y) if row["language"] == lang and g == (t == 1))}/'
                          f'{sum(1 for row in rows if row["language"] == lang)}' for lang in languages}
    unseen = [i for i, row in enumerate(rows) if row['language'] not in TRAIN_LANGUAGES]
    if unseen:
        out['unseen_languages'] = f'{int((guess[unseen] == (y[unseen] == 1)).sum())}/{len(unseen)}'
    out['misses'] = [{'expected': bool(t), 'p': round(float(q), 3), 'question': row['question'], 'pageChars': row.get('pageChars'),
                      'attached': row.get('imageAttachment'), 'linked': row.get('linkedPage')}
                     for row, q, g, t in zip(rows, p, guess, y) if g != (t == 1)]
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--reports', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--js', type=Path)
    parser.add_argument('--model', default='webbrain-one/Ternary-Bonsai-2-2B-ONNX-WebGPU-Vision')
    parser.add_argument('--export', default='TINY_ASK_GATE_PROBE')
    args = parser.parse_args()
    train_rows, train_m, train_h, train_y = load(args.reports / 'gate-train.json')
    val_rows, val_m, val_h, val_y = load(args.reports / 'gate-validation.json')
    test_rows, test_m, test_h, test_y = load(args.reports / 'gate-test.json')
    mean, std = train_h.mean(0), train_h.std(0) + 1e-3
    z = lambda h: (h - mean) / std
    width = train_h.shape[1]
    report = {'rows': {'train': len(train_y), 'validation': len(val_y), 'test': len(test_y)},
              'zero_shot_test': metrics(test_rows, 1 / (1 + np.exp(-test_m)), test_y), 'candidates': []}
    best = None
    for l2 in [1e-4, 1e-3, 3e-3, 1e-2, 3e-2, 1e-1, 3e-1]:
        start = np.zeros(width + 2)
        start[0] = 1.0
        params = minimize(objective, start, args=(train_m, z(train_h), train_y, l2), jac=True, method='L-BFGS-B',
                          options={'maxiter': 1000}).x
        p_val = predict(params, val_m, z(val_h))
        val = metrics(val_rows, p_val, val_y)
        report['candidates'].append({'l2': l2, 'validation': {k: v for k, v in val.items() if k != 'misses'}})
        key = (int(val['accuracy'].split('/')[0]), -val['nll'])
        if best is None or key > best[0]:
            best = (key, l2, params)
        print('l2', l2, json.dumps({k: v for k, v in val.items() if k not in ('misses', 'by_language')}))
    _, l2, params = best
    report['selected_l2'] = l2
    report['validation'] = metrics(val_rows, predict(params, val_m, z(val_h)), val_y)
    report['test'] = metrics(test_rows, predict(params, test_m, z(test_h)), test_y)
    print('selected', l2, 'test', json.dumps({k: v for k, v in report['test'].items() if k != 'misses'}, ensure_ascii=False))
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'gate-probe.json').write_text(json.dumps(report, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    a, w, b = unpack(params, width)
    folded = (w / std).astype(np.float32)
    bias = float(b - np.sum(w * mean / std))
    if args.js:
        test = report['test']
        source = Path(args.js).read_text(encoding='utf-8')
        start = source.index(f'export const {args.export} = Object.freeze({{')
        end = source.index('});', start) + len('});')
        # The validation line just above the probe is rewritten with it.
        line = source.rfind('\n', 0, start - 1) + 1
        if source.startswith('// Validation (generated', line):
            start = line
        body = (f"// Validation (generated templates, {len(TRAIN_LANGUAGES)} languages): {report['validation']['accuracy']}. Test (hand-written, "
                f"including {len({r['language'] for r in test_rows} - TRAIN_LANGUAGES)} languages absent from training): "
                f"{test['accuracy']}, unseen languages {test.get('unseen_languages', 'n/a')}.\n"
                f"export const {args.export} = Object.freeze({{\n"
                f"  model: '{args.model}',\n"
                f"  hiddenSize: {width},\n  margin: {float(a)!r},\n  bias: {bias!r},\n"
                f"  weightsBase64: '{base64.b64encode(folded.tobytes()).decode()}',\n"
                "});")
        Path(args.js).write_text(source[:start] + body + source[end:], encoding='utf-8')
        print('wrote', args.js)


if __name__ == '__main__':
    main()
