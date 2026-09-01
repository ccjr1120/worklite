import { describe, expect, it, vi } from 'vitest';
import { api, apiRequest, parseCommandEvent } from './client';

describe('apiRequest', () => {
  it('returns undefined for a successful 204 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(apiRequest('/api/example', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('preserves a structured API error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Unable to save' }), { status: 400 })));

    await expect(apiRequest('/api/example')).rejects.toMatchObject({ status: 400, message: 'Unable to save' });
  });
});

describe('parseCommandEvent', () => {
  it('accepts a complete command event', () => {
    expect(parseCommandEvent(JSON.stringify({ sequence: 1, commandId: 'cmd_1', type: 'stdout', data: 'ok', createdAt: '2026-01-01T00:00:00.000Z' }))).toEqual({
      sequence: 1,
      commandId: 'cmd_1',
      type: 'stdout',
      data: 'ok',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('rejects malformed command events', () => {
    expect(() => parseCommandEvent(JSON.stringify({ sequence: 1, commandId: 'cmd_1', type: 'stdout' }))).toThrow('invalid event');
  });
});

describe('resource mutation clients', () => {
  it('uses the MCP draft update endpoint and preserves the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'mcp_1', name: 'Docs', endpoint: 'https://example.test' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.updateMcpServer('personal', 'mcp_1', { name: 'Docs' })).resolves.toMatchObject({ id: 'mcp_1' });
    expect(fetchMock).toHaveBeenCalledWith('/api/mcp-servers/mcp_1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Docs' }) }));
  });

  it('sends an empty authentication token when the caller clears it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'mcp_1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.updateMcpServer('personal', 'mcp_1', { authToken: '' });
    expect(fetchMock).toHaveBeenCalledWith('/api/mcp-servers/mcp_1', expect.objectContaining({ body: JSON.stringify({ authToken: '' }) }));
  });
});
