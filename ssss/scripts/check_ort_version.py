import urllib.request, json

headers = {'User-Agent': 'Mozilla/5.0'}

# Check which ort version is in HF transformers 4.x
for v in ['4.2.0', '4.1.0', '4.0.0', '3.6.0']:
    try:
        url = f'https://unpkg.com/@huggingface/transformers@{v}/package.json'
        req = urllib.request.Request(url, headers=headers)
        data = json.loads(urllib.request.urlopen(req, timeout=10).read())
        deps = data.get('dependencies', {})
        ort = deps.get('onnxruntime-web', 'N/A')
        print(f'transformers@{v}: onnxruntime-web={ort}')
    except Exception as e:
        print(f'transformers@{v}: ERROR {e}')

# Also check if ort files exist in the transformers dist folder
print("\n-- Checking dist files in HF transformers 4.2.0 --")
file_names = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.mjs', 'ort.all.mjs', 'ort.bundle.min.mjs']
for f in file_names:
    for base in ['https://unpkg.com/@huggingface/transformers@4.2.0/dist/', 'https://unpkg.com/@huggingface/transformers@4.1.0/dist/']:
        try:
            req = urllib.request.Request(base + f, headers=headers)
            res = urllib.request.urlopen(req, timeout=10)
            size = len(res.read())
            print(f'FOUND {size} bytes: {base + f}')
        except Exception as e:
            print(f'MISS: {base + f} -> {str(e)[:50]}')
