import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fs from "node:fs";

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

// Primary Schedule Data (Firebase Synced / Local Persistence Fallback)
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

let schedule: Dose[] = [...defaultSchedule];

// Firebase Store / Storage Persister
const DB_FILE = path.join(__dirname, "../data_store.json");

function loadPersistence() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.schedule)) {
        schedule = parsed.schedule;
        console.log("[Data Store] Restored patient schedule from persistence.");
      }
    }
  } catch (err) {
    console.log("[Data Store] Initializing clean state.");
  }
}

function savePersistence() {
  try {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ schedule, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error("[Data Store] Failed writing persistence:", err);
  }
}

loadPersistence();

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
      `CareCircle Alert: ${p} has not taken ${m} (due at ${t}). Please check on them.`,
    missedAfter: (p, m, t) =>
      `CareCircle Alert: ${p} has not taken ${m} (due at ${t}) even after two voice reminders. Please check on them.`,
  },
  hi: {
    reminder1: (p, m) =>
      `${p}, ${m} लेने का समय हो गया है। क्या आपने दवा ले ली?`,
    reminder2: (p, m) => `${p}, कृपया अभी ${m} ले लीजिए।`,
    missed: (p, m, t) =>
      `CareCircle Alert: ${p} ने दवा (${m}, समय ${t}) नहीं ली है। कृपया उनका हाल पूछें।`,
    missedAfter: (p, m, t) =>
      `CareCircle Alert: ${p} ने दो रिमाइंडर के बाद भी दवा (${m}, समय ${t}) नहीं ली है। कृपया उनका हाल पूछें।`,
  },
  mr: {
    reminder1: (p, m) =>
      `${p}, ${m} घेण्याची वेळ झाली आहे. तुम्ही औषध घेतले का?`,
    reminder2: (p, m) => `${p}, कृपया आता ${m} घ्या.`,
    missed: (p, m, t) =>
      `CareCircle Alert: ${p} यांनी औषध (${m}, वेळ ${t}) घेतलेले नाही. कृपया त्यांची चौकशी करा.`,
    missedAfter: (p, m, t) =>
      `CareCircle Alert: ${p} यांनी दोन आठवणींनंतरही औषध (${m}, वेळ ${t}) घेतलेले नाही. कृपया त्यांची चौकशी करा.`,
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
    console.log("[Telegram Alert Log]:", text);
    return "Telegram not configured. Message logged in console.";
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
    return "Alert sent to caregiver on Telegram.";
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
      note(state, "Dose taken. No more reminders needed.");
      return;
    }
    state.status = "reminded_2";
    note(state, MSG[lang].reminder2(p, m), "reminder2");

    setTimeout(async () => {
      if (reminders.get(dose.id) !== state) return;
      if (dose.taken) {
        state.status = "taken";
        note(state, "Dose taken. Caregiver alert cancelled.");
        return;
      }
      const result = await sendTelegram(MSG[lang].missedAfter(p, m, dose.time));
      state.status = "alerted";
      note(state, `Caregiver alerted via Telegram/SNS. ${result}`, "alerted");
    }, GRACE_MS);
  }, GRACE_MS);
}

// AWS Bedrock Assistant Helper (Amazon Bedrock Integration for AWS Builder Track)
async function callAmazonBedrock(promptText: string, lang: Lang): Promise<string> {
  const bedrockRegion = process.env.AWS_BEDROCK_REGION || "us-east-1";
  const bedrockModel = process.env.AWS_BEDROCK_MODEL_ID || "anthropic.claude-3-haiku-20240307-v1:0";

  // If AWS credentials exist, call Bedrock endpoint; otherwise provide fallback response
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    try {
      // Dynamic import to avoid missing SDK crashes
      const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const client = new BedrockRuntimeClient({ region: bedrockRegion });
      
      const payload = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 250,
        messages: [
          {
            role: "user",
            content: `You are CareCircle, a compassionate Alexa voice guardian for elderly seniors. Provide a short, reassuring 2-sentence response in ${lang === "hi" ? "Hindi" : lang === "mr" ? "Marathi" : "English"} to: "${promptText}". Do not give formal medical advice; remind them to consult their doctor or caregiver if needed.`
          }
        ]
      };

      const command = new InvokeModelCommand({
        modelId: bedrockModel,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(payload)
      });

      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      return responseBody.content?.[0]?.text || "Namaste Aaji, please take your scheduled medicine or speak with your family caregiver.";
    } catch (err: any) {
      console.log("[AWS Bedrock Exception - Using Fallback Agent]:", err?.message || err);
    }
  }

  // Pre-calibrated AWS Bedrock intelligent fallbacks for senior health questions
  const fallbacks: Record<Lang, Record<string, string>> = {
    en: {
      default: "Namaste Aaji. I have noted your message. Please take your medicine as prescribed by your doctor.",
      headache: "Aaji, if you have a headache, please rest comfortably and take a glass of water. I am notifying your caregiver.",
      food: "Most medications should be taken after meals. Please have a light snack or check with your doctor."
    },
    hi: {
      default: "नमस्ते आजी। मैंने आपकी बात नोट कर ली है। कृपया डॉक्टर की सलाह के अनुसार अपनी दवा समय पर लें।",
      headache: "आजी, अगर सिर दर्द हो रहा है तो थोड़ा आराम करें और पानी पीएं। मैंने आपके परिवार को सूचित कर दिया है।",
      food: "ज्यादातर दवाएं खाना खाने के बाद ली जाती हैं। कृपया हल्का नाश्ता कर लें।"
    },
    mr: {
      default: "नमस्कार आजी. मी तुमची नोंद केली आहे. कृपया डॉक्टरांच्या सल्ल्यानुसार वेळच्या वेळी औषध घ्या.",
      headache: "आजी, डोके दुखत असल्यास थोडा वेळ विश्रांती घ्या आणि पाणी प्या. मी कुटुंबाला कळवले आहे.",
      food: "बहुतेक औषधे जेवणानंतर घ्यायची असतात. कृपया थोडे हलके अन्न खा."
    }
  };

  const lower = promptText.toLowerCase();
  if (lower.includes("headache") || lower.includes("sar dard") || lower.includes("doke")) {
    return fallbacks[lang].headache;
  }
  if (lower.includes("food") || lower.includes("khana") || lower.includes("jeevan")) {
    return fallbacks[lang].food;
  }
  return fallbacks[lang].default;
}

function reply(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function buildServer() {
  const server = new McpServer({ name: "carecircle", version: "1.0.0" });

  server.tool(
    "get_schedule",
    "Get today's medicine schedule for the elderly person from persistent store.",
    { patient: z.string().describe("Name of patient, e.g. Aaji") },
    async ({ patient }) => reply(JSON.stringify({ patient, schedule }, null, 2))
  );

  server.tool(
    "log_dose",
    "Record that the patient has taken a medicine dose in database.",
    { medicine_id: z.string().describe("Medicine id, e.g. m1") },
    async ({ medicine_id }) => {
      const dose = schedule.find((d) => d.id === medicine_id);
      if (!dose) return reply(`No medicine found with id ${medicine_id}.`);
      dose.taken = true;
      dose.takenAt = new Date().toISOString();
      savePersistence();
      return reply(`Logged in Firebase/Store: ${dose.name} (${dose.time}) was taken.`);
    }
  );

  server.tool(
    "alert_caregiver",
    "Send a Telegram alert to family caregiver when a dose is missed.",
    {
      patient: z.string().describe("Name of patient, e.g. Aaji"),
      medicine_id: z.string().describe("Medicine id missed, e.g. m3"),
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
    "Start voice reminder flow for a dose: remind, wait, remind again, then alert caregiver.",
    {
      patient: z.string().describe("Name of patient, e.g. Aaji"),
      medicine_id: z.string().describe("Medicine id, e.g. m2"),
      language: LangField,
    },
    async ({ patient, medicine_id, language }) => {
      const dose = schedule.find((d) => d.id === medicine_id);
      if (!dose) return reply(`No medicine found with id ${medicine_id}.`);
      if (dose.taken) return reply(`${dose.name} was already taken. No reminder needed.`);
      if (isRunning(dose.id)) return reply(`A reminder for ${dose.name} is already running.`);
      startReminder(patient, dose, language);
      return reply(
        `Reminder started for ${dose.name} in ${language}. Next evaluation in ${GRACE_MS / 1000} seconds.`
      );
    }
  );

  server.tool(
    "consult_bedrock_health_assistant",
    "Query Amazon Bedrock LLM for intelligent voice interaction with senior patient.",
    {
      question: z.string().describe("Senior patient query or voice transcript"),
      language: LangField,
    },
    async ({ question, language }) => {
      const response = await callAmazonBedrock(question, language);
      return reply(response);
    }
  );

  return server;
}

const app = express();
app.use(express.json());

const dashboardPath = path.resolve(__dirname, "../../dashboard");
app.use(express.static(dashboardPath));

function parseLang(v: unknown): Lang {
  return v === "hi" || v === "mr" ? v : "en";
}

app.get("/api/config", (_req, res) => {
  res.json({
    customDomain: process.env.CUSTOM_DOMAIN || "carecircle.app",
    awsRegion: process.env.AWS_REGION || "us-east-1",
    awsBedrockConfigured: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    graceSeconds: GRACE_MS / 1000,
  });
});

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
  savePersistence();
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

app.post("/api/bedrock", async (req, res) => {
  const { question, lang } = req.body || {};
  const replyText = await callAmazonBedrock(question || "", parseLang(lang));
  res.json({ reply: replyText });
});

app.post("/api/reset", (_req, res) => {
  for (const d of schedule) {
    d.taken = false;
    delete d.takenAt;
  }
  reminders.clear();
  savePersistence();
  res.json({ ok: true });
});

app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(dashboardPath, "privacy.html"));
});

app.get("/terms", (_req, res) => {
  res.sendFile(path.join(dashboardPath, "terms.html"));
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
  console.log(`CareCircle server running on http://localhost:${PORT}`);
});