// Day 2, step 1: verify the model works and inspect its output shape
// BEFORE wiring it into a browser extension — much easier to debug here.
//
// Run locally (needs internet access to huggingface.co on first run,
// to download ~6MB of quantized weights — they're cached after that):
//
//   npm install @huggingface/transformers
//   node test-model.mjs ./sample.jpg
//
// (grab any test image with a person in it and save it as sample.jpg
// in this folder, or pass a different path as the argument)

import { pipeline } from "@huggingface/transformers";

const imagePath = process.argv[2] || "./sample.jpg";

console.log("Loading Xenova/yolos-tiny (ViT-based object detector)...");
const detector = await pipeline("object-detection", "Xenova/yolos-tiny");

console.log(`Running inference on ${imagePath}...`);
const start = performance.now();
const output = await detector(imagePath, { threshold: 0.5 });
const elapsedMs = performance.now() - start;

console.log(`\nInference took ${elapsedMs.toFixed(1)} ms (CPU, Node — the`);
console.log(`browser with WebGPU should be faster on real hardware).\n`);

console.log(`Found ${output.length} object(s):`);
output.forEach((det) => {
  console.log(
    `  - ${det.label} (${(det.score * 100).toFixed(1)}%) at`,
    det.box
  );
});

// This is the shape you'll be working with in the browser too:
// [{ score: 0.98, label: "person", box: { xmin, ymin, xmax, ymax } }, ...]
