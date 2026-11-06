import { describe, expect, it, vi } from 'vitest';
import { AgentOfficialAccountController } from './agent-official-account.controller';

describe('Agent Official Account configuration', () => {
  it('uses the publishing Agent scope, including private sub-Agents', async () => {
    const agents = { get: vi.fn(async () => ({ collaboration: { capabilities: [{ type: 'wechat-official-account/publish' }] } })) };
    const account = { id: 'account', status: 'connected' };
    const officialAccount = { getAccount: vi.fn(async () => account), startAccountLogin: vi.fn(async () => account), disconnect: vi.fn(async () => account) };
    const controller = new AgentOfficialAccountController(agents as never, officialAccount as never);
    const request = {} as never;
    expect(await controller.get(request, 'publisher', 'lead')).toEqual(account);
    await controller.login(request, 'publisher', 'lead');
    await controller.disconnect(request, 'publisher', 'lead');
    expect(agents.get).toHaveBeenCalledWith(request, 'personal', 'publisher', 'lead');
    expect(officialAccount.startAccountLogin).toHaveBeenCalledOnce();
    expect(officialAccount.disconnect).toHaveBeenCalledOnce();
  });

  it('does not operate an account through an Agent without publishing capability', async () => {
    const agents = { get: vi.fn(async () => ({ collaboration: { capabilities: [] } })) };
    const officialAccount = { startAccountLogin: vi.fn(), disconnect: vi.fn() };
    const controller = new AgentOfficialAccountController(agents as never, officialAccount as never);
    await expect(controller.login({} as never, 'coder')).rejects.toThrow('no WeChat Official Account');
    await expect(controller.disconnect({} as never, 'coder')).rejects.toThrow('no WeChat Official Account');
    expect(officialAccount.startAccountLogin).not.toHaveBeenCalled();
    expect(officialAccount.disconnect).not.toHaveBeenCalled();
  });
});
