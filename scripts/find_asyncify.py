import urllib.request
import re
import sys
import os

headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

# Try listing files in dist/ folders across versions
versions = ['1.20.1', '1.19.0', '1.18.0', '1.17.3', '1.16.3', '1.14.0']
target_file = 'ort-wasm-simd-threaded.asyncify.mjs'
out_path = os.path.join('pii-agent-extension', 'lib', target_file)

print(f"=== Searching for {target_file} ===\n")

# Try direct file download
direct_urls = []
for v in versions:
    direct_urls.append(f'https://unpkg.com/onnxruntime-web@{v}/dist/{target_file}')
    direct_urls.append(f'https://cdn.jsdelivr.net/npm/onnxruntime-web@{v}/dist/{target_file}')

# Also try huggingface transformers package
for v in ['3.5.2', '3.4.1', '3.3.3', '3.2.4', '3.1.2', '3.0.2']:
    direct_urls.append(f'https://cdn.jsdelivr.net/npm/@huggingface/transformers@{v}/dist/{target_file}')
    direct_urls.append(f'https://unpkg.com/@huggingface/transformers@{v}/dist/{target_file}')

for url in direct_urls:
    try:
        req = urllib.request.Request(url, headers=headers)
        res = urllib.request.urlopen(req, timeout=15)
        content = res.read()
        print(f"FOUND ({len(content)} bytes): {url}")
        # Save the file
        with open(out_path, 'wb') as f:
            f.write(content)
        print(f"Saved to {out_path}")
        sys.exit(0)
    except Exception as e:
        print(f"MISS: {url} -> {str(e)[:60]}")

print("\n=== Trying listing approach ===")
for v in versions:
    try:
        req = urllib.request.Request(f'https://registry.npmjs.org/onnxruntime-web/{v}', headers=headers)
        data = urllib.request.urlopen(req, timeout=10).read().decode()
        import json
        pkg = json.loads(data)
        tarball = pkg.get('dist', {}).get('tarball', '')
        print(f"v{v} tarball: {tarball}")
    except Exception as e:
        print(f"v{v} registry error: {e}")
