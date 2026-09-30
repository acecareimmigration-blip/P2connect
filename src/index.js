import { createApp } from "./app.js";
const port = Number(process.env.PORT || 10000);
createApp().listen(port, "0.0.0.0", () => console.log(`P2connect listening on port ${port}`));
