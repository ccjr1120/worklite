import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SaveIndicator } from '@/components/save-indicator';
import { StatusBadge } from '@/components/status-badge';
import { WorkspaceChrome } from '@/components/workspace/workspace-chrome';
import { skills } from '@/mock/data';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/$teamSlug/skills/$skillId')({
  component: SkillEditorPage,
});

const FILES = [
  { path: 'SKILL.md', content: '# web-search\n\nSearch the public web and return cited findings.\n' },
  { path: 'scripts/search.sh', content: '#!/usr/bin/env bash\necho "sandboxed search"\n' },
  { path: 'references/limits.md', content: 'Executable content runs in a sandbox with filesystem, network, time, memory, and CPU limits.\n' },
];

function SkillEditorPage() {
  const { t } = useTranslation(['skills', 'common']);
  const { teamSlug, skillId } = Route.useParams();
  const isNew = skillId === 'new';
  const skill = skills.find((item) => item.id === skillId);
  const [selected, setSelected] = useState(FILES[0]?.path ?? 'SKILL.md');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'unsaved'>(isNew ? 'unsaved' : 'saved');
  const file = FILES.find((item) => item.path === selected);

  return (
    <div className="flex h-full min-h-0">
      <WorkspaceChrome
        crumbs={[
          { label: t('title'), to: `/${teamSlug}/skills` },
          { label: isNew ? t('editor.new') : skill?.name ?? t('editor.fallback') },
        ]}
        status={<SaveIndicator state={saveState} />}
        actions={
          <>
            <Button variant="secondary" size="compact" onClick={() => { setSaveState('saving'); window.setTimeout(() => setSaveState('saved'), 400); }}>
              {t('editor.validate')}
            </Button>
            <Button size="compact" onClick={() => toast.success(t('editor.published'))}>
              {t('common:actions.publish')}
            </Button>
          </>
        }
      />
      <aside className="w-56 shrink-0 overflow-auto border-r border-border bg-surface p-3">
        <p className="px-2 text-xs font-medium text-muted-foreground">{t('editor.package')}</p>
        <ul className="mt-2 space-y-1">
          {FILES.map((item) => (
            <li key={item.path}>
              <button
                type="button"
                onClick={() => setSelected(item.path)}
                className={cn(
                  'w-full rounded-md px-2 py-1.5 text-left font-mono text-[12px]',
                  selected === item.path ? 'bg-brand-subtle text-foreground' : 'text-muted-foreground hover:bg-surface-subtle',
                )}
              >
                {item.path}
              </button>
            </li>
          ))}
        </ul>
        {skill ? <div className="mt-4 px-2"><StatusBadge status={skill.validation} /></div> : null}
        <p className="mt-4 px-2 text-[12px] text-muted-foreground">{t('editor.safetyHint')}</p>
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        <textarea
          className="h-[calc(100%-2rem)] min-h-80 w-full resize-none rounded-lg border border-border bg-background p-4 font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={file?.content ?? ''}
          onChange={() => setSaveState('unsaved')}
          spellCheck={false}
          aria-label={selected}
        />
      </div>
    </div>
  );
}
