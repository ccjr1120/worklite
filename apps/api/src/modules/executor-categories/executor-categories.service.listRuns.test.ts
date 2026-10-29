import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { AgentTeamsService } from './executor-categories.service';

describe('AgentTeamsService.listRuns', () => {
  let service: AgentTeamsService;
  let mockDb: Record<string, unknown>;
  let mockWorkspaces: Record<string, unknown>;
  let mockConfig: Record<string, unknown>;
  let mockRuntime: Record<string, unknown>;
  let mockRequest: Request;

  beforeEach(() => {
    mockDb = {
      select: vi.fn(),
    };
    mockWorkspaces = {
      getWorkspace: vi.fn().mockResolvedValue({ id: 'ws-123' }),
    };
    mockConfig = {};
    mockRuntime = {};
    mockRequest = {} as Request;

    service = new AgentTeamsService(mockDb as any, mockWorkspaces as any, mockRuntime as any, mockConfig as any);
  });

  it('should fetch paginated runs with cursor pagination', async () => {
    const mockRuns = [
      {
        id: 'run-1',
        intent: 'Test task 1',
        projectDirectory: '/project1',
        mode: 'implement_and_validate',
        modeRationale: null,
        modeDecidedAt: null,
        status: 'succeeded',
        createdAt: new Date('2024-01-02'),
        finishedAt: new Date('2024-01-02T01:00:00'),
        executorCategoryId: 'team-1',
        teamName: 'Executor A',
        snapshot: { orchestrationVersion: 11 },
      },
      {
        id: 'run-2',
        intent: 'Test task 2',
        projectDirectory: '/project2',
        mode: 'implement_and_validate',
        modeRationale: null,
        modeDecidedAt: null,
        status: 'running',
        createdAt: new Date('2024-01-01'),
        finishedAt: null,
        executorCategoryId: 'team-1',
        teamName: 'Executor A',
        snapshot: { orchestrationVersion: 11 },
      },
    ];

    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockRuns),
    };

    (mockDb.select as any).mockReturnValue(mockQuery);

    const result = await service.listRuns(mockRequest, 'personal', ['team-1'], undefined, 50);

    expect(result).toEqual({
      items: [
        {
          id: 'run-1',
          intent: 'Test task 1',
          projectDirectory: '/project1',
          mode: 'implement_and_validate',
          modeRationale: null,
          modeDecidedAt: null,
          orchestrationVersion: 11,
          status: 'succeeded',
          createdAt: '2024-01-02T00:00:00.000Z',
          finishedAt: '2024-01-02T01:00:00.000Z',
          executorCategoryId: 'team-1',
          teamName: 'Executor A',
        },
        {
          id: 'run-2',
          intent: 'Test task 2',
          projectDirectory: '/project2',
          mode: 'implement_and_validate',
          modeRationale: null,
          modeDecidedAt: null,
          orchestrationVersion: 11,
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
          finishedAt: null,
          executorCategoryId: 'team-1',
          teamName: 'Executor A',
        },
      ],
      nextCursor: expect.any(String),
      total: 2,
    });
  });

  it('should filter by multiple executorCategoryIds', async () => {
    const mockRuns: unknown[] = [];
    const mockQuery = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(mockRuns),
    };

    (mockDb.select as any).mockReturnValue(mockQuery);

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

    (mockDb.select as any).mockReturnValue(mockQuery);

    // Test max limit
    await service.listRuns(mockRequest, 'personal', [], undefined, 500);
    expect(mockQuery.limit).toHaveBeenCalledWith(201); // 200 + 1 for hasNextPage check

    // Test default limit
    await service.listRuns(mockRequest, 'personal', [], undefined, undefined);
    expect(mockQuery.limit).toHaveBeenCalledWith(51); // 50 + 1
  });
});
