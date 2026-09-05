import os, json, httpx, asyncio

# Load .env
with open('.env', 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            k = k.strip(); v = v.strip().strip("'\"")
            if k and k not in os.environ:
                os.environ[k] = v

async def test():
    api_key = os.getenv('GEMINI_API_KEY', '')
    print(f'Key loaded: {bool(api_key)}, length: {len(api_key)}, prefix: {api_key[:10]}')

    url = f'https://generativelanguage.googleapis.com/v1/models/gemini-3.6-flash:generateContent?key={api_key}'
    payload = {
        "contents": [{"parts": [{"text": "Say hello in one word."}]}],
        "generationConfig": {"temperature": 0.0}
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(url, json=payload)
        print(f'HTTP status: {resp.status_code}')
        if resp.status_code == 200:
            data = resp.json()
            text = data['candidates'][0]['content']['parts'][0]['text']
            print(f'SUCCESS - Gemini responded: {text[:100]}')
        else:
            print(f'FAILED - Error body: {resp.text[:600]}')

asyncio.run(test())
