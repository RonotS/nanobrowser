// Settings → Command Center: signing in with a Command Center login, who is signed in, which models the company gives
// Bash AI and how many Command Center tools the person's role allows. It takes the place of the provider cards and API
// keys: Bash AI uses only the company's keys, through Command Center.
import { useEffect, useState } from 'react';
import { Button, Notice } from '@src/ui/components';
import { useStorage } from '@src/ui/hooks';
import { t } from '@src/ui/i18n';
import {
  allCommandCenterTools,
  commandCenterStorage,
  commandCenterUrl,
  listViewAsMembers,
  renewCommandCenter,
  setViewAs,
  signInToCommandCenter,
  signOutOfCommandCenter,
} from '@src/store/command-center';
import type { CommandCenterConnection, ViewAsMember } from '@src/store/command-center';
import { SettingsCard, SettingsRow } from './SettingsCard';

const PROVIDER_NAMES = { claude: 'Claude', openai: 'OpenAI', grok: 'Grok' } as const;

/** The sign-in button and its error, shared by this section and the welcome page. */
export function CommandCenterSignIn({ onSignedIn }: { onSignedIn?: (c: CommandCenterConnection) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            signInToCommandCenter()
              .then(connection => onSignedIn?.(connection))
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(false));
          }}>
          {busy ? t('cc.signingIn') : t('cc.signIn')}
        </Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}

function SignedIn({ connection }: { connection: CommandCenterConnection }) {
  const [busy, setBusy] = useState<'refresh' | 'out' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tools = allCommandCenterTools(connection);
  const reads = tools.filter(x => x.readOnly).length;
  const actions = tools.length - reads;
  const providers = (Object.keys(PROVIDER_NAMES) as Array<keyof typeof PROVIDER_NAMES>).filter(p =>
    connection.models.some(m => m.provider === p),
  );
  return (
    <div className="flex flex-col gap-6">
      <SettingsRow
        label={t('cc.signedInAs', { name: connection.viewer?.name ?? connection.user.name })}
        description={
          connection.viewer
            ? t('cc.viewAsNow', { name: connection.user.name, role: connection.user.role })
            : `${connection.user.email} · ${connection.user.role}`
        }>
        <Button
          disabled={busy !== null}
          onClick={() => {
            setBusy('refresh');
            setError(null);
            renewCommandCenter()
              .catch((e: Error) => setError(e.message))
              .finally(() => setBusy(null));
          }}>
          {busy === 'refresh' ? t('cc.refreshing') : t('cc.refresh')}
        </Button>
        <Button
          variant="danger"
          disabled={busy !== null}
          onClick={() => {
            setBusy('out');
            void signOutOfCommandCenter().finally(() => setBusy(null));
          }}>
          {t('cc.signOut')}
        </Button>
      </SettingsRow>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <SettingsRow label={t('cc.models')} description={t('cc.modelsHint')}>
        <ul className="flex flex-col gap-1 text-sm">
          {providers.map(p => (
            <li key={p}>
              <span className="font-medium">{PROVIDER_NAMES[p]}</span>
              <span className="text-nb-muted">
                {' · '}
                {connection.models
                  .filter(m => m.provider === p)
                  .map(m => m.label ?? m.name)
                  .join(', ')}
              </span>
            </li>
          ))}
        </ul>
      </SettingsRow>
      {connection.extras?.media.image.length || connection.extras?.media.video.length ? (
        <SettingsRow label={t('cc.media')} description={t('cc.mediaHint')}>
          <ul className="flex flex-col gap-1 text-sm">
            {[...connection.extras.media.image, ...connection.extras.media.video].map(m => (
              <li key={m.name}>{m.label ?? m.name}</li>
            ))}
          </ul>
        </SettingsRow>
      ) : null}
      {connection.extras?.voice.agents.length || connection.extras?.voice.transcription ? (
        <SettingsRow label={t('cc.voice')} description={t('cc.voiceHint')}>
          <ul className="flex flex-col gap-1 text-sm">
            {connection.extras.voice.agents.map(a => (
              <li key={a.name}>
                {a.label ?? a.name} <span className="text-nb-muted">· {a.name}</span>
              </li>
            ))}
            {connection.extras.voice.transcription ? (
              <li>
                {t('cc.dictation')}{' '}
                <span className="text-nb-muted">· {connection.extras.voice.transcription.name}</span>
              </li>
            ) : null}
          </ul>
        </SettingsRow>
      ) : null}
      <SettingsRow label={t('cc.tools')} description={t('cc.toolsHint')}>
        <span className="text-sm">{t('cc.toolsCount', { reads, actions })}</span>
      </SettingsRow>
      <ViewAsRow connection={connection} />
    </div>
  );
}

/**
 * View as: a developer sees Bash AI as a staff member does (their role, tools, brief and chats). Shown only to a person
 * Command Center lets view as others; the member list is asked as themselves.
 */
function ViewAsRow({ connection }: { connection: CommandCenterConnection }) {
  const [members, setMembers] = useState<ViewAsMember[] | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const viewing = connection.viewer ? connection.user : null;
  const signedIn = connection.viewer?.id ?? connection.user.id;
  useEffect(() => {
    let live = true;
    listViewAsMembers()
      .then(answer => {
        if (live) setMembers(answer.allowed ? answer.members : null);
      })
      .catch(() => {
        if (live) setMembers(null);
      });
    return () => {
      live = false;
    };
  }, [signedIn]);
  if (!members) return null;
  const run = (work: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    work.catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const choice = members.find(m => m.id === picked);
  return (
    <SettingsRow label={t('cc.viewAs')} description={t('cc.viewAsHint')}>
      <div className="flex flex-col items-end gap-2">
        {viewing ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-800 dark:text-amber-200">
              {t('cc.viewAsNow', { name: viewing.name, role: viewing.role })}
            </span>
            <Button disabled={busy} onClick={() => run(setViewAs(null))}>
              {t('viewAs.exit')}
            </Button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <select
            aria-label={t('cc.viewAsPick')}
            className="max-w-56 rounded-lg border border-nb-border bg-nb-bg px-2 py-1.5 text-sm"
            value={picked}
            onChange={e => setPicked(e.target.value)}>
            <option value="">{t('cc.viewAsPick')}</option>
            {members
              .filter(m => m.id !== signedIn)
              .map(m => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.role}
                </option>
              ))}
          </select>
          <Button
            disabled={busy || !choice}
            onClick={() => choice && run(setViewAs({ id: choice.id, name: choice.name, role: choice.role }))}>
            {t('cc.viewAsStart')}
          </Button>
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </SettingsRow>
  );
}

export function CommandCenterSection() {
  const connection = useStorage(commandCenterStorage, null);
  return (
    <div className="flex flex-col gap-6">
      <h2 className="sr-only">{t('settings.nav.providers')}</h2>
      <SettingsCard title={t('cc.title')} description={t('cc.description')}>
        {connection ? <SignedIn connection={connection} /> : <CommandCenterSignIn />}
      </SettingsCard>
      <p className="px-1 text-xs text-nb-muted">{t('cc.address', { url: commandCenterUrl() })}</p>
    </div>
  );
}
