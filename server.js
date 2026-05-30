/**
 * Florida Lotto Winner Alerts — Backend Server
 * - Manages all registered users and their tickets
 * - Checks FL Lotto results every Wed & Sat night
 * - Texts users ONLY when they win
 * - FL Lotto: 6 numbers (1-53)
 */

const express = require("express");
const twilio = require("twilio");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");

const app = express();
app.use(express.json());

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "";
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || "";

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const DB_FILE = "./users.json";

function loadUsers() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "{}");
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveUsers(users) {
  fs.writeFileSync(DB_FILE, JSON.stringify(users, null, 2));
}

const PRIZES = {
  "6": "JACKPOT",
  "5": 5000,
  "4": 100,
  "3": 5,
};

function checkTicket(ticket, draw) {
  const matched = ticket.numbers.filter(n => draw.numbers.includes(n)).length;
  const key = `${matched}`;
  const prize = PRIZES[key] || 0;
  return { matched, prize, key };
}

async function fetchLatestDrawing() {
  try {
    const url = "https://data.floridalottery.com/resource/lotto.json?$limit=1&$order=draw_date+DESC";
    const res = await axios.get(url, { timeout: 10000 });
    const draw = res.data[0];
    const nums = draw.winning_numbers.split(" ").map(Number);
    return {
      numbers: nums.slice(0, 6),
      date: draw.draw_date,
    };
  } catch (err) {
    console.error("Could not fetch FL Lotto results:", err.message);
    throw err;
  }
}

function buildWinMessage(draw, ticketResults, totalWon, hasJackpot) {
  const date = new Date(draw.date).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric"
  });
  const winningNums = draw.numbers.join("-");

  const lines = ticketResults
    .map((r, i) => {
      if (!r.prize) return null;
      if (r.prize === "JACKPOT") return `  Ticket ${i+1}: JACKPOT WINNER!`;
      return `  Ticket ${i+1}: +$${r.prize.toLocaleString()} (${r.matched} matched)`;
    })
    .filter(Boolean);

  const summary = hasJackpot
    ? "YOU HIT THE JACKPOT! Contact FL Lottery immediately!"
    : `Total: $${totalWon.toLocaleString()}`;

  return [
    `YOU WON! Florida Lotto — ${date}`,
    `Winning: ${winningNums}`,
    ``,
    lines.join("\n"),
    ``,
    summary,
    `Check your tickets to claim your prize!`,
  ].join("\n");
}

async function sendSms(toPhone, message) {
  return client.messages.create({
    body: message,
    from: TWILIO_FROM_NUMBER,
    to: `+1${toPhone}`,
  });
}

async function checkAllUsersAndNotify() {
  console.log(`\n[${new Date().toLocaleString()}] Checking FL Lotto results...`);

  let draw;
  try {
    draw = await fetchLatestDrawing();
    console.log(`Draw: ${draw.numbers.join("-")} (${draw.date})`);
  } catch (err) {
    console.error("Could not fetch results:", err.message);
    return;
  }

  const users = loadUsers();
  const phones = Object.keys(users);
  console.log(`Checking ${phones.length} registered users...`);

  let winnersCount = 0;

  for (const phone of phones) {
    const user = users[phone];
    if (!user.active) continue;

    const ticketResults = user.tickets.map(t => checkTicket(t, draw));
    const totalWon = ticketResults.reduce((s, r) => {
      if (!r.prize || r.prize === "JACKPOT") return s;
      return s + r.prize;
    }, 0);
    const hasJackpot = ticketResults.some(r => r.prize === "JACKPOT");

    if (totalWon > 0 || hasJackpot) {
      try {
        const message = buildWinMessage(draw, ticketResults, totalWon, hasJackpot);
        await sendSms(phone, message);
        console.log(`Texted winner: ***${phone.slice(-4)}`);
        winnersCount++;
      } catch (err) {
        console.error(`Failed to text ${phone.slice(-4)}:`, err.message);
      }
    }
  }

  console.log(`Done. ${winnersCount} winner(s) notified.`);
}

// Wed & Sat at 11:15 PM Eastern (after 11:00 PM draw)
cron.schedule("15 23 * * 3,6", checkAllUsersAndNotify, {
  timezone: "America/New_York"
});

app.post("/register", (req, res) => {
  const { phone, tickets } = req.body;
  if (!phone || !tickets || !Array.isArray(tickets)) {
    return res.status(400).json({ error: "Phone and tickets are required." });
  }
  const users = loadUsers();
  users[phone] = { tickets, registeredAt: new Date().toISOString(), active: true };
  saveUsers(users);
  console.log(`New user: ***${phone.slice(-4)} with ${tickets.length} ticket(s)`);
  res.json({ success: true, message: "Registered! You'll be texted only when you win." });
});

app.post("/update-tickets", (req, res) => {
  const { phone, tickets } = req.body;
  if (!phone || !tickets) {
    return res.status(400).json({ error: "Phone and tickets are required." });
  }
  const users = loadUsers();
  if (!users[phone]) {
    return res.status(404).json({ error: "Phone not registered." });
  }
  users[phone].tickets = tickets;
  users[phone].updatedAt = new Date().toISOString();
  saveUsers(users);
  res.json({ success: true, message: "Tickets updated!" });
});

app.post("/cancel", (req, res) => {
  const { phone } = req.body;
  const users = loadUsers();
  if (users[phone]) {
    users[phone].active = false;
    saveUsers(users);
  }
  res.json({ success: true });
});

app.get("/check-now", async (req, res) => {
  res.json({ status: "Checking FL Lotto results now!" });
  await checkAllUsersAndNotify();
});

app.get("/stats", (req, res) => {
  const users = loadUsers();
  const active = Object.values(users).filter(u => u.active).length;
  res.json({
    totalUsers: Object.keys(users).length,
    activeSubscribers: active,
    estimatedAnnualRevenue: `$${(active * 2.54).toFixed(2)}`,
  });
});

app.get("/privacy", (req, res) => {
  const path = require("path");
  res.sendFile(path.join(__dirname, "privacy.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "running", schedule: "Wed & Sat at 11:00 PM ET" });
});

app.listen(3000, () => {
  console.log("Florida Lotto Winner Alerts server running on port 3000");
  console.log("Schedule: Wednesday & Saturday at 11:00 PM Eastern");
});