import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import type { Database } from '@worklite/db';
import { CodersService } from './coders.service';
import type { AgentTeamRuntimeService } from './coder-runtime.service';
import type { AgentTeamConfigurationService } from './coder-configuration.service';
import type { WorkspaceService } from '../teams/teams.service';

describe('CodersService.listRuns', () => {
  let service: CodersService;
  let mockDb: Record<string, unknown>;
  let mockWorkspaces: Record<string, unknown>;
  let mockConfig: Record<string, unknown>;
  let mockRuntime: Record<string, unknown>;
  let mockRequest: Request;

  let selectMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    selectMock = vi.fn();
    mockDb = {
      select: selectMock,
    };
    mockWorkspaces = {
      getWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
    };
    mockConfig = {};
    mockRuntime = {};
    mockRequest = {} as Request;

    service = new CodersService(
      mockDb as unknown as Database,
      mockWorkspaces as unknown as WorkspaceService,
      mockRuntime as unknown as AgentTeamRuntimeService,
      mockConfig as unknown as AgentTeamConfigurationService,
    );
  });

  it('should fetch paginated runs with cursor pagination', async () => {
    const mockRuns = [
      {
        id: 'run-1',
        intent: 'Test task 1',
        projectDirectory: '/project1',
        status: 'succeeded',
        createdAt: new Date('2024-01-02'),
        finishedAt: new Date('2024-01-02T01:00:00Z'),
        coderId: 'team-1',
        snapshot: { orchestrationVersion: 12, coderName: 'Coder A', projectExecutorLaunches: {}, roles: [] },
      },
      {
        id: 'run-2',
        intent: 'Test task 2',
        projectDirectory: '/project2',
        status: 'running',
        createdAt: new Date('2024-01-01'),
        finishedAt: null,
        coderId: 'team-1',
        snapshot: { orchestrationVersion: 12, coderName: 'Coder A', projectExecutorLaunches: {}, roles: [] },
      },
    ];

    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockRuns),
    };

    // The in-progress Run's overview reads its attempts and activity; it has none yet.
    const emptyQuery = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockResolvedValue([]),
    };

    selectMock.mockReturnValueOnce(mockQuery).mockReturnValue(emptyQuery);

    const result = await service.listRuns(mockRequest, 'personal', ['team-1'], undefined, 50);

    expect(result).toEqual({
      items: [
        {
          id: 'run-1',
          intent: 'Test task 1',
          projectDirectory: '/project1',
          orchestrationVersion: 12,
          status: 'succeeded',
          createdAt: '2024-01-02T00:00:00.000Z',
          finishedAt: '2024-01-02T01:00:00.000Z',
          coderId: 'team-1',
          coderName: 'Coder A',
          // No Gateway is wired in this test, so tokens are unavailable rather than 0.
          overview: { totalTokens: { tokens: null, source: 'unavailable', reason: 'gateway_unavailable' }, durationMs: expect.any(Number) },
        },
        {
          id: 'run-2',
          intent: 'Test task 2',
          projectDirectory: '/project2',
          orchestrationVersion: 12,
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
          finishedAt: null,
          coderId: 'team-1',
          coderName: 'Coder A',
          // No Gateway is wired in this test, so tokens are unavailable rather than 0.
          overview: { totalTokens: { tokens: null, source: 'unavailable', reason: 'gateway_unavailable' }, durationMs: expect.any(Number) },
        },
      ],
      nextCursor: expect.any(String),
      total: 2,
    });
  });

  it('should filter by multiple coderIds', async () => {
    const mockRuns: unknown[] = [];
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockRuns),
    };

    selectMock.mockReturnValue(mockQuery);

    await service.listRuns(mockRequest, 'personal', ['team-1', 'team-2'], undefined, 50);

    expect(mockDb.select).toHaveBeenCalled();
    // Verify that query.where was called to filter by teams
    expect(mockQuery.where).toHaveBeenCalled();
  });

  it('should respect limit boundaries', async () => {
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };

    selectMock.mockReturnValue(mockQuery);

    // Test max limit
    await service.listRuns(mockRequest, 'personal', [], undefined, 500);
    expect(mockQuery.limit).toHaveBeenCalledWith(201); // 200 + 1 for hasNextPage check

    // Test default limit
    await service.listRuns(mockRequest, 'personal', [], undefined, undefined);
    expect(mockQuery.limit).toHaveBeenCalledWith(51); // 50 + 1
  });
});
