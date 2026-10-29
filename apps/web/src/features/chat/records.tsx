import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Copy, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatConversationRecordsQuery, usePortkeyGatewayStatsQuery } from '@/api/queries';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from '@/components/locale-provider';
import { formatDateTime, formatNumber } from '@/i18n/format';
import type { ChatTaskReference, GatewayAttributionGroup } from '@worklite/contracts';

// Gateway statistics are retained indefinitely, so a conversation's lifetime total
// starts at the epoch. The upper bound is left out on purpose: it defaults to the
// current instant server-side, and sending one would change the query key on every
// render and refetch forever.
const USAGE_FROM = new Date(0).toISOString();

function ConversationUsage({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('assistant');
  const { locale } = useLocale();
  const query = usePortkeyGatewayStatsQuery({ from: USAGE_FROM, groupBy: 'conversation', conversationId });
  const groups: GatewayAttributionGroup[] = query.data?.attribution.groups ?? [];
  // The conversation's own model loop and its project executors are separate surfaces
  // on purpose; the total is their sum and each is also shown on its own. A group whose
  // provider reported no usage stays out of the sum rather than counting as zero.
  const counted = groups.map((group) => group.totalTokens).filter((value): value is number => value !== null);
  const tokens = counted.length ? counted.reduce((sum, value) => sum + value, 0) : null;
  const requests = groups.reduce((sum, group) => sum + group.requests, 0);
  const perSurface = groups.map((group) => `${t(`usage.surfaces.${group.surface ?? 'unattributed'}` as never)}: ${group.totalTokens === null ? t('usage.unavailable') : formatNumber(group.totalTokens, locale)}`);
  return <section aria-labelledby="chat-conversation-usage" className="rounded-md border border-border bg-surface-subtle p-3">
    <h3 id="chat-conversation-usage" className="text-sm font-medium">{t('usage.title')}</h3>
    {query.isLoading ? <Skeleton className="mt-2 h-12 w-full" /> : query.isError ? (
      <p role="alert" className="mt-2 text-[13px] text-danger">{t('usage.loadFailed')}</p>
    ) : <>
      <dl className="mt-2 grid gap-3 text-[13px] sm:grid-cols-2">
        <div><dt className="text-muted-foreground">{t('usage.totalTokens')}</dt><dd className="tabular-nums">{tokens === null ? t('usage.unavailable') : formatNumber(tokens, locale)}</dd></div>
        <div><dt className="text-muted-foreground">{t('usage.requests')}</dt><dd className="tabular-nums">{formatNumber(requests, locale)}</dd></div>
      </dl>
      {perSurface.length ? <p className="mt-2 text-[13px] text-muted-foreground">{perSurface.join(' · ')}</p> : null}
      <p className="mt-2 text-[13px] text-muted-foreground">{t('usage.caveat')}</p>
    </>}
  </section>;
}

export function TaskLink({ reference }: { reference: ChatTaskReference | null }) {
  const { t } = useTranslation('assistant');
  if (reference?.kind === 'workflow') return <Link className="text-[13px] text-brand-text underline underline-offset-4" to="/runs/$runId" params={{ runId: reference.runId }}>{t('records.openTask')}</Link>;
  if (reference?.kind === 'executor_category') return <Link className="text-[13px] text-brand-text underline underline-offset-4" to="/executor-runs/$runId" params={{ runId: reference.runId }}>{t('records.openTask')}</Link>;
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
      <ConversationUsage conversationId={conversationId} />
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
