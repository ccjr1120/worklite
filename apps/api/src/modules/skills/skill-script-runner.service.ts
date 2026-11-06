import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { CommandExecutionView } from '@worklite/contracts';
import { CommandsService, type CommandReservation } from '../commands/commands.service';

type PackageFile = { path: string; content: string };
type StartOptions = { cwd?: string; reserveCommand?: CommandReservation; chatContext?: { executionId: string; submissionId: string; userMessageId: string } };

@Injectable()
export class SkillScriptRunnerService {
  constructor(private readonly commands: CommandsService) {}

  async start(files: PackageFile[], scriptPath: string, argumentsValue: string[], options?: StartOptions): Promise<CommandExecutionView> {
    const invocationId = `skill_run_${randomUUID()}`;
    const root = join(tmpdir(), 'worklite-skill-runs', invocationId);
    const resolvedRoot = resolve(root);
    const script = files.find((file) => file.path === scriptPath);
    if (!script || !scriptPath.startsWith('scripts/') || !script.content.startsWith('#!')) {
      throw new BadRequestException('The selected Skill script is not executable.');
    }

    await mkdir(root, { recursive: true, mode: 0o700 });
    try {
      for (const file of files) {
        const destination = resolve(root, file.path);
        if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${sep}`)) {
          throw new BadRequestException('The Skill package contains an unsafe path.');
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await writeFile(destination, file.content, { encoding: 'utf8', mode: 0o600 });
      }

      const executable = resolve(root, scriptPath);
      await chmod(executable, 0o700);
      const invocation = [executable, ...argumentsValue].map(shellQuote).join(' ');
      const command = options?.chatContext
        ? `WORKLITE_CHAT_EXECUTION_ID=${shellQuote(options.chatContext.executionId)} WORKLITE_CHAT_SUBMISSION_ID=${shellQuote(options.chatContext.submissionId)} WORKLITE_CHAT_USER_MESSAGE_ID=${shellQuote(options.chatContext.userMessageId)} ${invocation}`
        : invocation;
      if (options?.reserveCommand && !options.cwd) throw new BadRequestException('A project directory is required for journaled Skill scripts.');
      const execution = options?.reserveCommand
        ? await this.commands.createWithReservation(command, options.cwd ?? '', options.reserveCommand)
        : options?.cwd
          ? await this.commands.createWithReservation(command, options.cwd, () => undefined)
          : await this.commands.create({ command });
      void this.commands.waitForCompletion(execution.id).then(
        () => rm(root, { recursive: true, force: true }).catch(() => undefined),
        () => rm(root, { recursive: true, force: true }).catch(() => undefined),
      );
      return execution;
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async executeAndWait(files: PackageFile[], scriptPath: string, argumentsValue: string[]) {
    const started = await this.start(files, scriptPath, argumentsValue);
    return this.wait(started.id);
  }

  async wait(commandId: string) {
    const execution = await this.commands.waitForCompletion(commandId);
    return { execution, output: await this.commands.output(commandId), stdout: await this.commands.output(commandId, 'stdout') };
  }

  cancel(commandId: string): Promise<CommandExecutionView> {
    return this.commands.cancel(commandId);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
