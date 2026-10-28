import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// In browser mode the UI reads JSON fixtures made by `totalrecalc-dump`.
// They are served from ./fixtures, or from $TOTALRECALC_FIXTURES when set.
function fixtures(): Plugin {
  const dir = process.env.TOTALRECALC_FIXTURES ?? path.resolve(__dirname, "fixtures");
  return {
    name: "totalrecalc-fixtures",
    configureServer(server) {
      server.middlewares.use("/fixtures/", (req, res, next) => {
        const file = path.join(dir, decodeURIComponent((req.url ?? "").split("?")[0]));
        if (!file.startsWith(dir) || !fs.existsSync(file)) return next();
        res.setHeader("Content-Type", "application/json");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [fixtures()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022" },
});
