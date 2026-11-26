# Privacy: what Bash AI sends, and where

Bash AI is Kinetic Scaling's internal AI assistant for Chrome. This page says what leaves your browser when you use it, and where it goes. It covers this build of the extension; the Command Center side is in the `kinetic-command-center` repository.

## What stays in your browser

- Your conversations, attachments, shortcuts, site settings and other settings are stored in your browser.
- Your logins and cookies for other sites never leave your browser through Bash AI.
- The values of password, payment-card and one-time-code fields on a page are hidden from the AI model.
- There are no AI provider keys in the browser. Bash AI keeps only your Command Center sign-in (a 12-hour access token and a 90-day refresh token) in the extension's storage.

## What goes to Command Center

Bash AI signs in with your Command Center account and sends everything through Command Center:

- **Model requests.** Your messages, attachments, and the content of the tabs it works in (including screenshots, for models that can see images) go to Command Center, which forwards them to the model's provider (Anthropic, OpenAI or xAI) with the company's key and streams the answer back. Page content is sent only while a task is running.
- **Command Center tools.** When Bash AI looks something up or changes something in Command Center (a client, a task, an SOP), the request goes to Command Center as you, limited to your role.
- **Chat history.** After each task, the conversation is saved in Command Center (Assistant → Bash AI chats), where you see your own and managers see everyone's. What is saved is what the panel showed: your messages, the answers, one short label per step, and file names. It never includes the text of pages, screenshots, or what was typed into a page. Command Center also adds saved chats to Bash AI's search, so you can find your earlier conversations.
- **Memories.** A fact you ask Bash AI to remember is saved in Command Center, the same place as the in-app assistant's memories, and can be removed on the Memories page.
- **Dictation and media.** Voice recordings for dictation, and requests to make an image or a video, go through Command Center to OpenAI or xAI. Recordings are not kept.
- **The company brief.** Bash AI reads a brief written for you from Command Center (systems, your role and ClickUp list, SOPs, the team's rules and memories) and puts it in the model's instructions.

## The voice agent

For a live voice conversation, Command Center gives the panel a secret that works for one minute. The panel then connects straight to the provider (xAI's Grok, or OpenAI), and your voice and its answers stream between your browser and the provider. Command Center does not receive the audio.

## No analytics

This build sends no usage data. Nanobrowser's anonymous daily count and usage counts are switched off (no analytics key is set), and the uninstall survey is removed.

## The providers

How Anthropic, OpenAI and xAI handle what they receive is governed by the company's agreements with them and their own policies.

## Your control

- Delete a conversation in the panel to remove it from your browser. Its copy in Command Center stays; ask a manager to remove it.
- Sign out in Settings → Command Center to remove your sign-in from the extension. Deactivating your Command Center account also stops Bash AI.
- Remove the extension to delete everything it stored in your browser.

## Questions

Ask Aaron (GitHub: RonotS).

Last updated: November 25, 2026
