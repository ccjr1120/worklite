import type { AgentExecutionView } from '@worklite/contracts';
import { formatDateTime } from '@/i18n/format';
import type { AppLocale } from '@/i18n/locale';

type ExecutionLogLabels = {
  title: string;
  generated: string;
  executionId: string;
  phase: string;
  errorCode: string;
  status: string;
  incomplete: string;
  reason: string;
  cancelledReason: string;
  transcript: string;
  noMessages: string;
  user: string;
  assistant: string;
  activity: string;
  noActivity: string;
  skill: string;
  script: string;
  toolCallId: string;
  commandExecutionId: string;
  exitCode: string;
  statuses: Record<AgentExecutionView['status'], string>;
};

function escapeMarkdownText(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('=', '&#61;')
    .replace(/([\\`*_[\]{}()#+\-.!|~])/g, '\\$1');
}

// User content must not be able to restructure the exported document, so headings,
// setext underlines, and raw HTML are neutralized outside fenced code blocks.
function protectAssistantMarkdown(value: string) {
  let openFence: { character: string; length: number } | null = null;
  const lines: string[] = [];
  for (const line of value.replace(/\r\n?/g, '\n').split('\n')) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!openFence) openFence = { character: marker[0], length: marker.length };
      else if (marker[0] === openFence.character && marker.length >= openFence.length) openFence = null;
      lines.push(line);
      continue;
    }
    if (openFence) {
      lines.push(line);
      continue;
    }
    const protectedLine = line
      .replace(/^(\s{0,3})(#{1,6})(?=\s|$)/, (_match, indent: string, hashes: string) => `${indent}${'#'.repeat(Math.max(4, hashes.length))}`)
      .replaceAll('<', '&lt;');
    if (/^\s*=+\s*$/.test(protectedLine)) lines.push(protectedLine.replaceAll('=', '&#61;'));
    else if (/^\s*-{2,}\s*$/.test(protectedLine)) lines.push(protectedLine.replaceAll('-', '\\-'));
    else lines.push(protectedLine);
  }
  if (openFence) lines.push('', openFence.character.repeat(openFence.length));
  return lines.join('\n');
}

function downloadExecutionLog(execution: AgentExecutionView, labels: ExecutionLogLabels, locale: AppLocale, executionError: string) {
  const generatedAt = new Date();
  const lines = [
    `# ${labels.title}`,
    '',
    `- **${labels.generated}:** ${formatDateTime(generatedAt, locale)}`,
    `- **${labels.executionId}:** ${execution.id}`,
    `- **${labels.status}:** ${labels.statuses[execution.status]}`,
    `- **${labels.phase}:** ${execution.phase}`,
    `- **${labels.errorCode}:** ${execution.errorCode ?? 'none'}`,
    '',
  ];
  if (execution.status === 'running') lines.push(`> ${labels.incomplete}`, '');
  if (executionError) lines.push(`- **${labels.reason}:** ${escapeMarkdownText(executionError)}`, '');
  else if (execution.status === 'cancelled') lines.push(`- **${labels.reason}:** ${escapeMarkdownText(labels.cancelledReason)}`, '');
  lines.push(`## ${labels.transcript}`, '');
  if (execution.messages.length === 0) lines.push(labels.noMessages, '');
  else {
    execution.messages.forEach((message, index) => {
      const speaker = message.role === 'user' ? labels.user : labels.assistant;
      const content = message.role === 'user' ? escapeMarkdownText(message.content.replace(/\r\n?/g, '\n')) : protectAssistantMarkdown(message.content);
      lines.push(`### ${index + 1}. ${speaker}`, '', content, '');
    });
  }
  lines.push(`## ${labels.activity}`, '');
  if (execution.toolCalls.length === 0) lines.push(labels.noActivity, '');
  else {
    for (const call of execution.toolCalls) {
      const pathSegments = call.scriptPath?.split(/[\\/]/).filter(Boolean) ?? [];
      const skillName = escapeMarkdownText(call.skillName || labels.skill);
      const scriptName = escapeMarkdownText(pathSegments[pathSegments.length - 1] || labels.script);
      const exitCode = call.exitCode === null ? '' : ` | **${labels.exitCode}:** ${call.exitCode}`;
      const identifiers = ` | **${labels.toolCallId}:** ${call.id}${call.commandExecutionId ? ` | **${labels.commandExecutionId}:** ${call.commandExecutionId}` : ''}`;
      lines.push(`- **${skillName}** | **${labels.script}:** ${scriptName} | **${labels.status}:** ${labels.statuses[call.status]}${exitCode}${identifiers}`);
    }
    lines.push('');
  }
  const blob = new Blob([`${lines.join('\n').trimEnd()}\n`], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `worklite-chat-${generatedAt.toISOString().replaceAll(':', '-')}.md`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export { downloadExecutionLog };
