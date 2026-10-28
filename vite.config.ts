import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// In browser mode the UI reads JSON fixtures made by `totalrecalc-dump`.
// They are served from ./fixtures, or from $TOTALRECALC_FIXTURES when set.
function fixtures(): Plugin {
  const dir = fs.realpathSync(process.env.TOTALRECALC_FIXTURES ?? path.resolve(import.meta.dirname, "fixtures"));
  return {
    name: "totalrecalc-fixtures",
    configureServer(server) {
      server.middlewares.use("/fixtures/", (req, res, next) => {
        let name: string;
        try {
          name = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        } catch {
          return next();
        }
        // Only plain .json files directly inside the fixtures folder.
        if (!/^[\w.-]+\.json$/.test(name)) return next();
        const file = path.join(dir, name);
        let real: string;
        try {
          real = fs.realpathSync(file);
        } catch {
          return next();
        }
        if (path.relative(dir, real).includes(path.sep) || !fs.statSync(real).isFile()) return next();
        res.setHeader("Content-Type", "application/json");
        fs.createReadStream(real).on("error", () => res.end()).pipe(res);
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
