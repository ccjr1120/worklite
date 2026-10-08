import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Copy, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatConversationRecordsQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime } from '@/i18n/format';
import type { ChatTaskReference } from '@worklite/contracts';

export function TaskLink({ reference }: { reference: ChatTaskReference | null }) {
  const { t } = useTranslation('assistant');
  if (reference?.kind === 'workflow') return <Link className="text-[13px] text-brand underline underline-offset-4" to="/runs/$runId" params={{ runId: reference.runId }}>{t('records.openTask')}</Link>;
  if (reference?.kind === 'team') return <Link className="text-[13px] text-brand underline underline-offset-4" to="/agent-teams/$teamId" params={{ teamId: reference.teamId }} search={{ tab: 'conversation' }}>{t('records.openTask')}</Link>;
  return null;
}

function RawRecord({ value }: { value: unknown }) {
  const { t } = useTranslation('assistant');
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const text = JSON.stringify(value, null, 2) ?? '';
  return <div className="relative mt-2 rounded-md border border-border bg-surface-subtle p-3"><div className="mb-2 flex items-center justify-end gap-2"><Button variant="ghost" size="compact" onClick={() => { void navigator.clipboard.writeText(text).then(() => setState('copied')).catch(() => setState('failed')); }}><Copy className="size-3.5" />{t(state === 'copied' ? 'records.copied' : 'records.copy')}</Button>{state === 'failed' ? <span role="alert" className="text-xs text-danger">{t('records.copyFailed')}</span> : null}</div><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs leading-5">{text}</pre></div>;
}

export function ConversationRecords({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const query = useChatConversationRecordsQuery(conversationId);
  const data = query.data;
  function download() {
    if (!data) return;
    const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = href; link.download = `worklite-chat-${conversationId}.json`; link.click(); URL.revokeObjectURL(href);
  }
  return <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 md:p-6">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-medium">{t('records.title')}</h2><Button variant="secondary" size="compact" onClick={download} disabled={!data}><Download className="size-4" />{t('records.download')}</Button></div>
    {query.isLoading ? <Skeleton className="h-40 w-full" /> : null}
    {query.isError ? <div className="space-y-2"><p role="alert" className="text-sm text-danger">{t('records.loadFailed')}</p><Button variant="secondary" size="compact" onClick={() => void query.refetch()}>{t('history.retry')}</Button></div> : null}
    {data ? <>
      <dl className="grid gap-3 text-[13px] sm:grid-cols-2"><div><dt className="text-muted-foreground">{t('records.conversationId')}</dt><dd className="break-all font-mono">{data.conversation.id}</dd></div><div><dt className="text-muted-foreground">{t('history.channel')}</dt><dd>{data.conversation.channel}</dd></div>{data.conversation.channelConversationId ? <div><dt className="text-muted-foreground">{t('records.channelConversationId')}</dt><dd className="break-all font-mono">{data.conversation.channelConversationId}</dd></div> : null}</dl>
      {data.execution ? <details><summary className="cursor-pointer text-sm font-medium">{t('records.execution')}</summary><RawRecord value={data.execution} /></details> : null}
      <details open><summary className="cursor-pointer text-sm font-medium">{t('records.submissions')} · {data.submissions.length}</summary><div className="mt-2 space-y-3">{data.submissions.map((submission) => <details key={submission.id} className="border-b border-border pb-3"><summary className="cursor-pointer break-all text-[13px]">{formatDateTime(submission.createdAt, locale)} · {submission.id} · {t(submission.error ? 'status.failed' : data.conversation.channel === 'web' ? submission.reference ? 'records.accepted' : 'records.processing' : submission.settled ? 'records.settled' : submission.outputMessageId ? 'records.delivered' : 'records.pending')}</summary><TaskLink reference={submission.reference} /><RawRecord value={submission} /></details>)}</div></details>
      <details><summary className="cursor-pointer text-sm font-medium">{t('records.channelEvents')} · {data.receipts.length}</summary><div className="mt-2 space-y-3">{data.receipts.map((receipt) => <details key={receipt.id} className="border-b border-border pb-3"><summary className="cursor-pointer break-all text-[13px]">{formatDateTime(receipt.createdAt, locale)} · {receipt.payload.direction === 'outbound' ? t('records.outbound') : t('records.inbound')} · {t(`records.status.${receipt.status}`)} · {receipt.id}</summary>{receipt.error ? <p className="mt-2 text-[13px] text-danger">{receipt.error}</p> : null}<RawRecord value={receipt} /></details>)}</div></details>
      <details><summary className="cursor-pointer text-sm font-medium">{t('records.agentEvents')} · {data.events.length}</summary><div className="mt-2 space-y-3">{data.events.map((event) => <details key={event.sequence} className="border-b border-border pb-3"><summary className="cursor-pointer text-[13px]">#{event.sequence} · {formatDateTime(event.createdAt, locale)} · {event.data.kind}</summary><RawRecord value={event} /></details>)}</div></details>
      <details><summary className="cursor-pointer text-sm font-medium">{t('records.deliveries')} · {data.deliveries.length}</summary><RawRecord value={data.deliveries} /></details>
      <p className="text-[13px] text-muted-foreground">{t('records.retainedFields')}</p>
    </> : null}
  </div>;
}
