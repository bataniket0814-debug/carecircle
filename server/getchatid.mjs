import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN;
const savedId = process.env.TELEGRAM_CHAT_ID;

if (!token) {
  console.log("Token nahi mila. .env file server folder ke andar hai aur naam bilkul .env hai?");
  process.exit(1);
}

const base = `https://api.telegram.org/bot${token}`;

const me = await (await fetch(`${base}/getMe`)).json();
if (!me.ok) {
  console.log("Token galat hai:", me.description);
  process.exit(1);
}
console.log("Bot:", "@" + me.result.username, "| Bot ki id:", me.result.id);

const upd = await (await fetch(`${base}/getUpdates`)).json();
const people = new Map();
for (const u of upd.result ?? []) {
  const m = u.message;
  if (m && m.from && !m.from.is_bot) people.set(m.chat.id, m.from.first_name);
}

if (people.size === 0) {
  console.log("Koi message nahi mila. Apne bot ko Telegram mein 'test' bhejo, phir script dobara chalao.");
} else {
  console.log("Tumhari sahi chat id (ise .env mein daalo):");
  for (const [id, name] of people) console.log("  ", id, "-", name);
}

console.log("Abhi .env mein chat id:", savedId ?? "(khali)");
if (String(savedId) === String(me.result.id)) {
  console.log("GALTI: .env mein bot ki id hai. Apni id daalo.");
}