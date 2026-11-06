import { PLATFORM_FAILURE_CONTRACT, platformFailure, type PlatformFailure } from '@worklite/db';
export { platformFailure, platformContractHash, type PlatformFailure } from '@worklite/db';

// Validate the JSON Schema vocabulary used by the protected tool manifest. Values
// never enter diagnostics; only schema paths and failed keywords are retained.
export function platformInputIssues(value: unknown, schema: Record<string, unknown>, path = '$'): Array<{ path: string; rule: string }> {
  const issues: Array<{ path: string; rule: string }> = [];
  const fail = (rule: string) => issues.push({ path, rule });
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((branch) => platformInputIssues(value, branch as Record<string, unknown>, path).length === 0)) fail('anyOf');
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const matches = (type: unknown) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === type;
  if (types.length && !types.some(matches)) { fail('type'); return issues; }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail('enum');
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail('minLength');
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail('maxLength');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) fail('pattern');
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail('minimum');
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail('maximum');
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail('minItems');
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail('maxItems');
    if (schema.items && typeof schema.items === 'object') value.forEach((item, index) => issues.push(...platformInputIssues(item, schema.items as Record<string, unknown>, `${path}[${index}]`)));
  } else if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of Array.isArray(schema.required) ? schema.required : []) if (typeof key === 'string' && !(key in record)) issues.push({ path: `${path}.${key}`, rule: 'required' });
    for (const key of Object.keys(record)) {
      if (properties[key]) issues.push(...platformInputIssues(record[key], properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) fail('additionalProperties');
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') issues.push(...platformInputIssues(record[key], schema.additionalProperties as Record<string, unknown>, `${path}.*`));
    }
  }
  return issues;
}

export function scriptFailure(output: string, responseContractFailure = false): PlatformFailure | null {
  // One terminal, credential-free envelope is emitted by lib.mjs. Stack traces
  // and API bodies are deliberately excluded from the persistent failure record.
  try {
    const wrapper = JSON.parse(output.trim());
    const value = responseContractFailure ? wrapper?.workliteEvidence : wrapper?.workliteFailure;
    if (value?.contract !== PLATFORM_FAILURE_CONTRACT || !Array.isArray(value.requests)) return null;
    const requests = value.requests.filter((item: unknown) => item && typeof item === 'object').map((item: Record<string, unknown>) => ({
      method: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(String(item.method)) ? String(item.method) : 'OTHER',
      status: typeof item.status === 'number' ? item.status : null,
      state: ['sent', 'responded', 'decoded'].includes(String(item.state)) ? String(item.state) : 'sent',
      requestId: typeof item.requestId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(item.requestId) ? item.requestId : null,
      pathHash: typeof item.pathHash === 'string' && /^[a-f0-9]{64}$/.test(item.pathHash) ? item.pathHash : null,
      ...([400, 404, 409, 422].includes(Number(item.status)) && typeof item.message === 'string' ? { message: item.message.slice(0, 1000) } : {}),
      apiCode: typeof item.apiCode === 'string' && /^[A-Z][A-Z0-9_]{1,100}$/.test(item.apiCode) ? item.apiCode : null,
    }));
    const writes = requests.filter((item: { method: string }) => item.method !== 'GET');
    const effect = writes.some((item: { status: number | null }) => item.status === null || item.status < 200 || item.status >= 300) ? 'unknown' : writes.length ? 'applied' : requests.length ? 'not_applied' : responseContractFailure ? 'unknown' : 'not_started';
    const lastStatus = requests.at(-1)?.status;
    const statusCode = lastStatus === 401 ? 'PLATFORM_AUTHENTICATION_FAILED' : lastStatus === 403 ? 'PLATFORM_PERMISSION_DENIED' : lastStatus === 404 ? 'PLATFORM_RESOURCE_NOT_FOUND' : lastStatus === 409 ? 'PLATFORM_CONFLICT' : lastStatus === 422 || lastStatus === 400 ? 'PLATFORM_API_INPUT_INVALID' : lastStatus === 429 ? 'PLATFORM_RATE_LIMITED' : lastStatus >= 500 ? 'PLATFORM_API_SERVER_ERROR' : 'PLATFORM_HTTP_ERROR';
    const code = responseContractFailure ? 'PLATFORM_RESULT_CONTRACT_INVALID' : value.code === 'PLATFORM_HTTP_ERROR' ? statusCode : ['PLATFORM_TRANSPORT_ERROR', 'PLATFORM_API_RESPONSE_INVALID', 'PLATFORM_CONFIGURATION_INVALID'].includes(value.code) ? value.code : 'PLATFORM_SCRIPT_ERROR';
    return platformFailure(responseContractFailure ? 'response' : requests.length ? 'api' : 'input', code, effect, { evidence: { requests }, ...(responseContractFailure ? { fields: [{ path: '$.worklite', rule: 'outputContract' }] } : {}) });
  } catch { return null; }
}
