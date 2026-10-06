// Test pixels, not HTTP acceptance. Two independently randomized solid colors
// avoid treating a model that always guesses one label as vision-capable.
export async function probeDecisionVision(config, evaluate, { random = () => crypto.getRandomValues(new Uint32Array(1))[0] } = {}) {
  const colors = ['red', 'blue', 'green', 'yellow'];
  const first = random() % colors.length;
  const second = (first + 1 + random() % 3) % colors.length;
  for (const index of [first, second]) {
    if (index === second) await new Promise(resolve => setTimeout(resolve, 1100));
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(64, 64) : Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    const context = canvas.getContext('2d'); context.fillStyle = colors[index]; context.fillRect(0, 0, 64, 64);
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const url = 'data:image/png;base64,' + btoa(String.fromCharCode(...bytes));
    const result = await evaluate({ config: { ...config, supportsVision: true },
      state: [{ type: 'image_url', image_url: { url } }],
      questions: { image_color: { type: 'choice', instructions: 'Which color fills the attached image? Answer from the pixels only.', criteria: Object.fromEntries(colors.map(c => [c, c + ' pixels'])) } } });
    const answer = result.answers.image_color;
    if (answer.choice !== colors[index] || answer.probabilities[colors[index]] < .9) return false;
  }
  return true;
}
