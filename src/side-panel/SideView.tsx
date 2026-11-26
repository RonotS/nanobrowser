// One side view of the panel (PanelRail): the person's ClickUp tasks, the ClickUp lists, Quality Checks or churn risk,
// read from Command Center for their role (and for whoever a developer views as). Read-only: a row opens the real
// page in a new tab, and Ask puts a question about it into the chat.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { readPanel } from '@src/store/command-center';
import type { PanelData, PanelTask, PanelView } from '@src/store/command-center';
import { t } from '@src/ui/i18n';
import type { MessageKey } from '@src/ui/i18n';
import { RestartIcon, SpinnerIcon } from '@src/ui/icons';
import { dueLabel, matching, taskSections } from './side-view';

const open = (url: string | null | undefined) => {
  if (url) void chrome.tabs.create({ url });
};

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function SideView({ view, onAsk }: { view: PanelView; onAsk: (text: string) => void }) {
  const [data, setData] = useState<PanelData[PanelView] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [at, setAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await readPanel(view));
      setAt(new Date().toISOString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [view]);

  useEffect(() => {
    setData(null);
    setQuery('');
    void load();
  }, [load]);

  const allUrl =
    view === 'quality' || view === 'churn'
      ? (data as PanelData['quality'] | null)?.url
      : view === 'lists'
        ? 'https://app.clickup.com/'
        : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-nb-border/60 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t(`rail.${view}` as MessageKey)}</h2>
        {at && !loading ? (
          <span className="text-[11px] text-nb-muted">{t('side.updated', { time: time(at) })}</span>
        ) : null}
        <button
          type="button"
          aria-label={t('side.refresh')}
          title={t('side.refresh')}
          disabled={loading}
          onClick={() => void load()}
          className="flex size-7 items-center justify-center rounded-lg text-nb-muted transition-colors hover:bg-nb-surface hover:text-nb-fg disabled:cursor-not-allowed disabled:opacity-50">
          {loading ? <SpinnerIcon size={14} className="animate-spin" /> : <RestartIcon size={14} />}
        </button>
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          type="search"
          value={query}
          placeholder={t('side.search')}
          onChange={e => setQuery(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-nb-border/70 bg-nb-bg px-2.5 py-1.5 text-sm outline-none focus:border-nb-accent"
        />
        {allUrl ? (
          <button
            type="button"
            onClick={() => open(allUrl)}
            className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-nb-accent hover:bg-nb-surface">
            {t('side.openAll', { place: view === 'lists' ? 'ClickUp' : 'Command Center' })}
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {error ? (
          <p role="alert" className="m-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
            {error}
          </p>
        ) : !data ? (
          <p className="px-3 py-4 text-sm text-nb-muted">{t('side.loading')}</p>
        ) : view === 'tasks' ? (
          <Tasks data={data as PanelData['tasks']} query={query} onAsk={onAsk} />
        ) : view === 'lists' ? (
          <Lists data={data as PanelData['lists']} query={query} onAsk={onAsk} />
        ) : view === 'quality' ? (
          <Quality data={data as PanelData['quality']} query={query} onAsk={onAsk} />
        ) : (
          <Churn data={data as PanelData['churn']} query={query} onAsk={onAsk} />
        )}
      </div>
    </section>
  );
}

function Row({
  title,
  meta,
  detail,
  badge,
  url,
  ask,
  onAsk,
}: {
  title: string;
  meta?: ReactNode;
  detail?: string | null;
  badge?: ReactNode;
  url?: string | null;
  ask?: string;
  onAsk: (text: string) => void;
}) {
  return (
    <li className="group flex items-start gap-2 rounded-xl p-2 hover:bg-nb-surface">
      <button
        type="button"
        onClick={() => open(url)}
        disabled={!url}
        title={url ? t('side.open') : undefined}
        className="min-w-0 flex-1 cursor-pointer text-left disabled:cursor-default">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-nb-fg">{title}</span>
          {badge}
        </span>
        {meta ? <span className="mt-0.5 block truncate text-[11px] text-nb-muted">{meta}</span> : null}
        {detail ? <span className="mt-1 line-clamp-2 text-xs text-nb-muted">{detail}</span> : null}
      </button>
      {ask ? (
        <button
          type="button"
          onClick={() => onAsk(ask)}
          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-nb-accent opacity-70 transition-opacity hover:bg-nb-bg group-hover:opacity-100">
          {t('side.ask')}
        </button>
      ) : null}
    </li>
  );
}

function Badge({ tone, children }: { tone: 'red' | 'amber' | 'green' | 'grey' | 'blue'; children: ReactNode }) {
  const tones = {
    red: 'bg-red-500/15 text-red-500',
    amber: 'bg-amber-500/15 text-amber-500',
    green: 'bg-emerald-500/15 text-emerald-500',
    grey: 'bg-nb-surface text-nb-muted',
    blue: 'bg-nb-accent/15 text-nb-accent',
  } as const;
  return (
    <span
      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tones[tone]}`}>
      {children}
    </span>
  );
}

const Heading = ({ children }: { children: ReactNode }) => (
  <h3 className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-nb-muted">{children}</h3>
);

const Empty = ({ filtered }: { filtered: boolean }) => (
  <p className="px-3 py-4 text-sm text-nb-muted">{filtered ? t('side.noMatch') : t('side.empty')}</p>
);

function Tasks({ data, query, onAsk }: { data: PanelData['tasks']; query: string; onAsk: (text: string) => void }) {
  const shown = matching(data.tasks, query, task => [task.title, task.status, task.list, task.client]);
  const sections = taskSections(shown);
  const row = (task: PanelTask) => (
    <Row
      key={task.id}
      title={task.title}
      meta={[task.status, task.list ?? task.client].filter(Boolean).join(' · ')}
      badge={
        task.due ? (
          <Badge tone={task.overdue ? 'red' : 'grey'}>{t('side.tasks.due', { date: dueLabel(task.due) })}</Badge>
        ) : null
      }
      url={task.url}
      ask={t('side.ask.task', { title: task.title })}
      onAsk={onAsk}
    />
  );
  return (
    <>
      {data.source === 'mirror' ? (
        <p className="px-2 pt-1 text-[11px] text-nb-muted">{t('side.tasks.mirror')}</p>
      ) : null}
      {!shown.length ? <Empty filtered={!!query} /> : null}
      {(
        [
          ['overdue', sections.overdue],
          ['upcoming', sections.upcoming],
          ['noDue', sections.noDue],
        ] as const
      ).map(([key, list]) =>
        list.length ? (
          <div key={key}>
            <Heading>
              {t(`side.tasks.${key}` as MessageKey)} · {list.length}
            </Heading>
            <ul>{list.map(row)}</ul>
          </div>
        ) : null,
      )}
    </>
  );
}

function Lists({ data, query, onAsk }: { data: PanelData['lists']; query: string; onAsk: (text: string) => void }) {
  const yours = matching(data.yours, query, l => [l.name, l.note]);
  const spaces = data.spaces
    .map(space => ({ ...space, lists: matching(space.lists, query, l => [l.name, l.folder, space.name]) }))
    .filter(space => space.lists.length);
  if (!yours.length && !spaces.length) return <Empty filtered={!!query} />;
  return (
    <>
      {yours.length ? (
        <div>
          <Heading>{t('side.lists.yours')}</Heading>
          <ul>
            {yours.map(l => (
              <Row
                key={`yours-${l.id}`}
                title={l.name}
                meta={l.note}
                url={l.url}
                ask={t('side.ask.list', { name: l.name })}
                onAsk={onAsk}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {spaces.map(space => (
        <div key={space.id}>
          <Heading>
            {space.name} · {space.lists.length}
          </Heading>
          <ul>
            {space.lists.map(l => (
              <Row
                key={l.id}
                title={l.name}
                meta={l.folder ?? undefined}
                url={l.url}
                ask={t('side.ask.list', { name: l.name })}
                onAsk={onAsk}
              />
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

function Quality({ data, query, onAsk }: { data: PanelData['quality']; query: string; onAsk: (text: string) => void }) {
  const shown = matching(data.clients, query, c => [c.name, c.stage, c.summary]);
  return (
    <>
      <p className="px-2 pt-1 text-[11px] text-nb-muted">
        {t('side.quality.mode', {
          mode: data.mode,
          open: data.summary.openClients,
          problems: data.summary.openProblems,
        })}
      </p>
      {!shown.length ? <Empty filtered={!!query} /> : null}
      <ul>
        {shown.map(c => (
          <Row
            key={c.id}
            title={c.name}
            meta={c.stage}
            detail={c.summary}
            badge={
              c.clear ? (
                <Badge tone="green">{t('side.quality.clear')}</Badge>
              ) : c.open ? (
                <Badge tone="amber">{t('side.quality.open', { count: c.open })}</Badge>
              ) : null
            }
            url={c.url}
            ask={t('side.ask.quality', { name: c.name })}
            onAsk={onAsk}
          />
        ))}
      </ul>
    </>
  );
}

const LEVEL = {
  risk: ['red', 'side.churn.risk'],
  watch: ['amber', 'side.churn.watch'],
  ok: ['green', 'side.churn.ok'],
} as const;

function Churn({ data, query, onAsk }: { data: PanelData['churn']; query: string; onAsk: (text: string) => void }) {
  const shown = matching(data.clients, query, c => [c.name, c.verdict, c.csm, c.level]);
  return (
    <>
      <p className="px-2 pt-1 text-[11px] text-nb-muted">{t('side.churn.counts', data.counts)}</p>
      {!shown.length ? <Empty filtered={!!query} /> : null}
      <ul>
        {shown.map(c => {
          const level = c.level ? LEVEL[c.level] : null;
          return (
            <Row
              key={c.id}
              title={c.name}
              meta={c.csm ?? undefined}
              detail={c.verdict}
              badge={
                level ? (
                  <Badge tone={level[0]}>{t(level[1])}</Badge>
                ) : (
                  <Badge tone="grey">{t('side.churn.unchecked')}</Badge>
                )
              }
              url={c.url}
              ask={t('side.ask.churn', { name: c.name })}
              onAsk={onAsk}
            />
          );
        })}
      </ul>
    </>
  );
}
