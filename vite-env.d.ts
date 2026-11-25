/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set only for unattended development runs (fixtures/autorun.mjs). */
  readonly WXT_AUTORUN_URL?: string;
  /** The PostHog project key and host; a production build with both sends analytics there. */
  readonly VITE_POSTHOG_API_KEY?: string;
  readonly VITE_POSTHOG_HOST?: string;
  /** The Command Center the AI signs in to; the live one when unset. A local one is http://localhost:3000. */
  readonly VITE_COMMAND_CENTER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
