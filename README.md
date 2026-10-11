# CareCircle

A voice-first medicine guardian for elderly people, built for the
Amazon Developer Hackathon (Alexa+ track).

> Demo data only. CareCircle is a reminder tool, not medical advice.

## The problem

Many elderly people forget their medicines and find reminder apps hard to use,
while family members who live far away are left worrying. CareCircle speaks to
them in their own language and tells the family only when it matters.

## What it does

- Reminds the elder by voice in **English, Hindi or Marathi**
- Asks whether the dose was taken and logs the answer
- If there is no reply, reminds again after a grace period
- If the dose is still missed, alerts the caregiver on **Telegram** in the same language
- A **family dashboard** shows each dose as pending, reminded, taken or caregiver alerted
- An **Alexa+ simulator** web page lets you try the whole conversation by button or voice

## How it works

A self-hosted **MCP server** (Streamable HTTP, built with the official
`@modelcontextprotocol/sdk`) exposes these tools:

| Tool | Purpose |
|---|---|
| `get_schedule` | Today's medicines and whether each was taken |
| `log_dose` | Record that a dose was taken |
| `start_reminder` | Remind, wait, remind again, then alert the caregiver |
| `get_reminder_status` | See what happened in the reminder flow |
| `alert_caregiver` | Send a Telegram alert directly |

The same server serves the dashboard and simulator from `dashboard/index.html`.

## Tech stack

Node.js, TypeScript, Express, Model Context Protocol SDK, Telegram Bot API,
plain HTML/CSS/JS with the browser Speech APIs.

## Setup

Requires Node.js 18 or newer.

1. Create a Telegram bot with @BotFather and note the token.
2. Send any message to your bot, then find your chat id (for example with @userinfobot).
3. Run:

```
cd server
npm install
copy .env.example .env
```

4. Open `.env` and fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
5. Start the server:

```
npm run dev
```

6. Open http://localhost:3000 for the dashboard and simulator.

### Test the MCP server

```
npx @modelcontextprotocol/inspector
```

Choose transport **Streamable HTTP** and URL `http://localhost:3000/mcp`.

### Environment variables

| Name | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Chat id of the caregiver |
| `GRACE_SECONDS` | Wait between reminders (default 20, short for demos) |

## Roadmap

- Persistent storage with Firebase Firestore
- Natural multilingual conversation with Amazon Bedrock

## License

MIT