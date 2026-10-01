import { createApp } from "./app.js";
import { startTelegramBot } from "./telegram.js";

const port = Number(process.env.PORT || 10000);
const app = createApp();

app.listen(port, "0.0.0.0", () => {
  console.log(`P2connect listening on port ${port}`);
  startTelegramBot({
    getStatus: () => ({
      status: "ok",
      binanceConfigured: Boolean(process.env.BINANCE_API_KEY && process.env.BINANCE_PRIVATE_KEY),
      timestamp: new Date().toISOString()
    })
  });
});
