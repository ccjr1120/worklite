const gatewayURL = (process.env.CODEX_TEST_GATEWAY_URL ?? 'http://127.0.0.1:23392').replace(/\/$/, '');

async function request(path, options = {}) {
  const url = `${gatewayURL}${path}`;
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { url, status: response.status, ok: response.ok, body };
  } catch (error) {
    return { url, status: null, ok: false, body: error instanceof Error ? error.message : String(error) };
  }
}

function print(label, result) {
  console.log(`\n${label}`);
  console.log(`URL: ${result.url}`);
  console.log(`Status: ${result.status ?? 'connection error'}`);
  console.log(typeof result.body === 'string' ? result.body : JSON.stringify(result.body, null, 2));
}

const auth = await request('/worklite/codex/auth/status');
print('Codex auth status', auth);

const providers = await request('/worklite/providers');
print('Gateway providers', providers);

const codexProvider = Array.isArray(providers.body)
  ? providers.body.find((provider) => provider?.protocol === 'codex/responses' || provider?.name === 'codex')
  : null;

if (!codexProvider?.id) {
  console.log('\nNo Codex Provider was returned; skipping provider test.');
  process.exitCode = 2;
} else {
  console.log(`\nSelected Codex Provider: ${codexProvider.name} (${codexProvider.id})`);
  const test = await request(`/worklite/providers/${encodeURIComponent(codexProvider.id)}/test`, { method: 'POST' });
  print('Codex provider test', test);
  if (!test.ok) process.exitCode = 1;
}
