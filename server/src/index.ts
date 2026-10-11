import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Lang = "en" | "hi" | "mr";

const LangField = z
  .enum(["en", "hi", "mr"])
  .default("en")
  .describe("Language: en (English), hi (Hindi) or mr (Marathi)");

type Dose = {
  id: string;
  name: string;
  names: Record<Lang, string>;
  time: string;
  taken: boolean;
  takenAt?: string;
};

type ReminderState = {
  patient: string;
  medicine: string;
  lang: Lang;
  status: "reminded_1" | "reminded_2" | "taken" | "alerted";
  log: string[];
  events: { type: "reminder1" | "reminder2" | "alerted"; text: string }[];
};

// Fake demo data (never use real patient data)
const defaultSchedule: Dose[] = [
  {
    id: "m1",
    name: "BP tablet",
    names: { en: "BP tablet", hi: "बीपी की गोली", mr: "बीपीची गोळी" },
    time: "08:00",
    taken: false,
  },
  {
    id: "m2",
    name: "Vitamin D",
    names: { en: "Vitamin D", hi: "विटामिन डी", mr: "व्हिटॅमिन डी" },
    time: "13:00",
    taken: false,
  },
  {
    id: "m3",
    name: "Sugar tablet",
    names: { en: "Sugar tablet", hi: "शुगर की गोली", mr: "शुगरची गोळी" },
    time: "20:00",
    taken: false,
  },
];

let schedule: Dose[] = defaultSchedule.map((d) => ({ ...d }));

// Simple persistence: the schedule is saved to a local JSON file.
const DB_FILE = path.resolve(__dirname, "../data_store.json");

function loadSchedule() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
      if (Array.isArray(parsed.schedule)) {
        schedule = parsed.schedule;
        console.log("Loaded saved schedule from data_store.json");
      }
    }
  } catch {
    console.log("Could not read data_store.json, starting with default data.");
  }
}

function saveSchedule() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({ schedule }, null, 2));
  } catch (err) {
    console.error("Could not write data_store.json:", err);
  }
}

loadSchedule();

type Msg = {
  reminder1: (p: string, m: string) => string;
  reminder2: (p: string, m: string) => string;
  missed: (p: string, m: string, t: string) => string;
  missedAfter: (p: string, m: string, t: string) => string;
};

const MSG: Record<Lang, Msg> = {
  en: {
    reminder1: (p, m) => `${p}, it's time to take your ${m}. Did you take it?`,
    reminder2: (p, m) => `${p}, please take your ${m} now.`,
    missed: (p, m, t) =>
      `⚠️ ${p} has not taken ${m} (due at ${t}). Please check on them.`,
    missedAfter: (p, m, t) =>
      `⚠️ ${p} has not taken ${m} (due at ${t}) even after two reminders. Please check on them.`,
  },
  hi: {
    reminder1: (p, m) =>
      `${p}, ${m} लेने का समय हो गया है। क्या आपने दवा ले ली?`,
    reminder2: (p, m) => `${p}, कृपया अभी ${m} ले लीजिए।`,
    missed: (p, m, t) =>
      `⚠️ ${p} ने दवा (${m}, समय ${t}) नहीं ली है। कृपया उनका हाल पूछें।`,
    missedAfter: (p, m, t) =>
      `⚠️ ${p} ने दो रिमाइंडर के बाद भी दवा (${m}, समय ${t}) नहीं ली है। कृपया उनका हाल पूछें।`,
  },
  mr: {
    reminder1: (p, m) =>
      `${p}, ${m} घेण्याची वेळ झाली आहे. तुम्ही औषध घेतले का?`,
    reminder2: (p, m) => `${p}, कृपया आता ${m} घ्या.`,
    missed: (p, m, t) =>
      `⚠️ ${p} यांनी औषध (${m}, वेळ ${t}) घेतलेले नाही. कृपया त्यांची चौकशी करा.`,
    missedAfter: (p, m, t) =>
      `⚠️ ${p} यांनी दोन आठवणींनंतरही औषध (${m}, वेळ ${t}) घेतलेले नाही. कृपया त्यांची चौकशी करा.`,
  },
};

function who(lang: Lang, patient: string) {
  return lang !== "en" && patient.trim().toLowerCase() === "aaji"
    ? "आजी"
    : patient;
}

const reminders = new Map<string, ReminderState>();
const GRACE_MS = Number(process.env.GRACE_SECONDS ?? "20") * 1000;

function stamp() {
  return new Date().toLocaleTimeString("en-IN");
}

async function sendTelegram(text: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log("[Telegram not configured] Would send:", text);
    return "Telegram not configured. Message printed in the server console only.";
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const body = await res.text();
      return `Telegram error: HTTP ${res.status} - ${body}`;
    }
    return "Alert sent to the caregiver on Telegram.";
  } catch (err: any) {
    return `Telegram error: ${err?.message || err}`;
  }
}

function note(
  state: ReminderState,
  text: string,
  type?: ReminderState["events"][number]["type"]
) {
  const line = `${stamp()} ${text}`;
  state.log.push(line);
  if (type) state.events.push({ type, text });
  console.log(line);
}

function isRunning(id: string) {
  const s = reminders.get(id);
  return !!s && (s.status === "reminded_1" || s.status === "reminded_2");
}

function startReminder(patient: string, dose: Dose, lang: Lang) {
  const p = who(lang, patient);
  const m = dose.names[lang];
  const state: ReminderState = {
    patient,
    medicine: dose.name,
    lang,
    status: "reminded_1",
    log: [],
    events: [],
  };
  reminders.set(dose.id, state);
  note(state, MSG[lang].reminder1(p, m), "reminder1");

  setTimeout(() => {
    if (reminders.get(dose.id) !== state) return;
    if (dose.taken) {
      state.status = "taken";
      note(state, "Dose taken. No more reminders.");
      return;
    }
    state.status = "reminded_2";
    note(state, MSG[lang].reminder2(p, m), "reminder2");

    setTimeout(async () => {
      if (reminders.get(dose.id) !== state) return;
      if (dose.taken) {
        state.status = "taken";
        note(state, "Dose taken. No alert needed.");
        return;
      }
      const result = await sendTelegram(MSG[lang].missedAfter(p, m, dose.time));
      state.status = "alerted";
      note(state, `Caregiver alerted. ${result}`, "alerted");
    }, GRACE_MS);
  }, GRACE_MS);
}

function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function buildServer() {
  const server = new McpServer({ name: "carecircle", version: "0.5.0" });

  server.tool(
    "get_schedule",
    "Get today's medicine schedule for the elderly person, with taken/not taken status.",
    { patient: z.string().describe("Name of the patient, e.g. Aaji") },
    async ({ patient }) => reply(JSON.stringify({ patient, schedule }, null, 2))
  );

  server.tool(
    "log_dose",
    "Record that the patient has taken a medicine dose.",
    { medicine_id: z.string().describe("Medicine id from the schedule, e.g. m1") },
    async ({ medicine_id }) => {
      const dose = schedule.find((d) => d.id === medicine_id);
      if (!dose) return reply(`No medicine found with id ${medicine_id}.`);
      dose.taken = true;
      dose.takenAt = new Date().toISOString();
      saveSchedule();
      return reply(`Logged: ${dose.name} (${dose.time}) was taken.`);
    }
  );

  server.tool(
    "alert_caregiver",
    "Send a Telegram alert to the family caregiver when a dose was missed, in English, Hindi or Marathi.",
    {
      patient: z.string().describe("Name of the patient, e.g. Aaji"),
      medicine_id: z.string().describe("Medicine id that was missed, e.g. m3"),
      language: LangField,
    },
    async ({ patient, medicine_id, language }) => {
      const dose = schedule.find((d) => d.id === medicine_id);
      if (!dose) return reply(`No medicine found with id ${medicine_id}.`);
      if (dose.taken) return reply(`${dose.name} was already taken. No alert needed.`);
      const result = await sendTelegram(
        MSG[language].missed(who(language, patient), dose.names[language], dose.time)
      );
      return reply(result);
    }
  );

  server.tool(
    "start_reminder",
    "Start the reminder flow for a dose in English, Hindi or Marathi: remind, wait, remind again, then alert the caregiver if still not taken.",
    {
      patient: z.string().describe("Name of the patient, e.g. Aaji"),
      medicine_id: z.string().describe("Medicine id to remind about, e.g. m2"),
      language: LangField,
    },
    async ({ patient, medicine_id, language }) => {
      const dose = schedule.find((d) => d.id === medicine_id);
      if (!dose) return reply(`No medicine found with id ${medicine_id}.`);
      if (dose.taken) return reply(`${dose.name} was already taken. No reminder needed.`);
      if (isRunning(dose.id)) return reply(`A reminder for ${dose.name} is already running.`);
      startReminder(patient, dose, language);
      return reply(
        `Reminder started for ${dose.name} in ${language}. Next step in ${GRACE_MS / 1000} seconds if the dose is not logged.`
      );
    }
  );

  server.tool(
    "get_reminder_status",
    "Check what happened in the reminder flow for a medicine.",
    { medicine_id: z.string().describe("Medicine id, e.g. m2") },
    async ({ medicine_id }) => {
      const state = reminders.get(medicine_id);
      if (!state) return reply(`No reminder has been started for ${medicine_id}.`);
      return reply(JSON.stringify(state, null, 2));
    }
  );

  return server;
}

const app = express();
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../../dashboard")));

function parseLang(v: unknown): Lang {
  return v === "hi" || v === "mr" ? v : "en";
}

app.get("/api/state", (_req, res) => {
  res.json({ schedule, reminders: Object.fromEntries(reminders) });
});

app.post("/api/log/:id", (req, res) => {
  const dose = schedule.find((d) => d.id === req.params.id);
  if (!dose) {
    res.status(404).json({ error: "not found" });
    return;
  }
  dose.taken = true;
  dose.takenAt = new Date().toISOString();
  saveSchedule();
  res.json({ ok: true });
});

app.post("/api/remind/:id", (req, res) => {
  const dose = schedule.find((d) => d.id === req.params.id);
  if (!dose) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (dose.taken) {
    res.json({ ok: false, message: "already taken" });
    return;
  }
  if (isRunning(dose.id)) {
    res.json({ ok: false, message: "already running" });
    return;
  }
  startReminder("Aaji", dose, parseLang(req.query.lang));
  res.json({ ok: true });
});

app.post("/api/reset", (_req, res) => {
  schedule = defaultSchedule.map((d) => ({ ...d }));
  reminders.clear();
  saveSchedule();
  res.json({ ok: true });
});

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`CareCircle MCP server running on http://localhost:${PORT}/mcp`);
});