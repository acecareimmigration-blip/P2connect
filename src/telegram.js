const API = "https://api.telegram.org/bot";

async function telegramCall(token, method, body = {}) {
  const response = await fetch(`${API}${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
  const data = await response.json();
  if (!data.ok) throw new Error(data.description || "Telegram API error");
  return data.result;
}

function allowedChat(chatId) {
  const raw = process.env.TELEGRAM_ALLOWED_CHAT_IDS || "";
  if (!raw.trim()) return true;
  return raw.split(",").map((x) => x.trim()).filter(Boolean).includes(String(chatId));
}

async function sendMessage(token, chatId, text) {
  return telegramCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

export function startTelegramBot({ getStatus }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN not configured");
    return;
  }

  let offset = 0;
  let running = true;

  async function poll() {
    while (running) {
      try {
        const updates = await telegramCall(token, "getUpdates", {
          offset,
          timeout: 25,
          allowed_updates: ["message"]
        });

        for (const update of updates) {
          offset = update.update_id + 1;
          const message = update.message;
          if (!message?.chat?.id || !message.text) continue;

          const chatId = message.chat.id;
          if (!allowedChat(chatId)) {
            await sendMessage(token, chatId, "Unauthorized chat.");
            continue;
          }

          const command = message.text.trim().split(/\s+/)[0].toLowerCase();
          if (command === "/start" || command === "/help") {
            await sendMessage(
              token,
              chatId,
              "P2connect online.\n\nCommands:\n/status — service status\n/health — health check\n/chatid — show this chat ID"
            );
          } else if (command === "/status") {
            const status = getStatus();
            await sendMessage(
              token,
              chatId,
              `P2connect: ${status.status}\nBinance configured: ${status.binanceConfigured ? "yes" : "no"}\nTime: ${status.timestamp}`
            );
          } else if (command === "/health") {
            await sendMessage(token, chatId, "P2connect health: OK");
          } else if (command === "/chatid") {
            await sendMessage(token, chatId, `Chat ID: ${chatId}`);
          }
        }
      } catch (error) {
        console.error("Telegram polling error:", error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  poll();
  console.log("Telegram bot polling enabled");
}
