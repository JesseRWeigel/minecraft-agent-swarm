import type { Bot } from "mineflayer";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { EventEmitter } from "events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, process.env.SWARM_BIND_HOST || undefined);
  });
}

export async function startViewer(bot: Bot, port = 3000) {
  const available = await isPortAvailable(port);
  if (!available) {
    console.log(`[Viewer] Port ${port} already in use — viewer disabled this session.`);
    return;
  }

  try {
    const { WorldView } = require("prismarine-viewer/viewer");
    const express = (await import("express")).default;
    const http = await import("http");
    const { Server: SocketServer } = await import("socket.io");
    const app = express();
    const httpServer = http.createServer(app);
    const io = new SocketServer(httpServer, { path: "/socket.io" });

    // Serve our custom viewer HTML on "/" before static assets
    app.get("/", (_req: any, res: any) => {
      // In dev (tsx), serve from src/; in production, serve from dist/
      const htmlPath = path.join(__dirname, "viewer-client.html");
      res.sendFile(htmlPath);
    });

    // Serve prismarine-viewer's static assets (webpack bundle, textures, etc.)
    const pvDir = path.dirname(require.resolve("prismarine-viewer/package.json"));
    app.use(express.static(path.join(pvDir, "public")));

    // Set up bot.viewer event emitter (matches prismarine-viewer's API)
    const sockets: any[] = [];
    const primitives: Record<string, any> = {};
    (bot as any).viewer = new EventEmitter();

    (bot as any).viewer.erase = (id: string) => {
      delete primitives[id];
      for (const s of sockets) s.emit("primitive", { id });
    };
    (bot as any).viewer.drawBoxGrid = (id: string, start: any, end: any, color = "aqua") => {
      primitives[id] = { type: "boxgrid", id, start, end, color };
      for (const s of sockets) s.emit("primitive", primitives[id]);
    };
    (bot as any).viewer.drawLine = (id: string, points: any, color = 0xff0000) => {
      primitives[id] = { type: "line", id, points, color };
      for (const s of sockets) s.emit("primitive", primitives[id]);
    };

    const viewDistance = 6;

    io.on("connection", (socket) => {
      socket.emit("version", (bot as any).version);
      sockets.push(socket);

      const worldView = new WorldView(bot.world, viewDistance, bot.entity.position, socket);
      worldView.init(bot.entity.position);

      for (const id in primitives) {
        socket.emit("primitive", primitives[id]);
      }

      worldView.on("blockClicked", (block: any, face: any, button: any) => {
        (bot as any).viewer.emit("blockClicked", block, face, button);
      });

      // Send position WITHOUT pitch — keeps client in third-person/orbit mode
      function botPosition() {
        socket.emit("position", {
          pos: bot.entity.position,
          yaw: bot.entity.yaw,
          addMesh: true,
        });
        worldView.updatePosition(bot.entity.position);
      }

      bot.on("move", botPosition);
      worldView.listenToBot(bot);

      socket.on("disconnect", () => {
        bot.removeListener("move", botPosition);
        worldView.removeListenersFromBot(bot);
        sockets.splice(sockets.indexOf(socket), 1);
      });
    });

    httpServer.listen(port, process.env.SWARM_BIND_HOST || undefined, () => {
      console.log(`[Viewer] Follow-camera viewer at http://localhost:${port}`);
      console.log(`[Viewer] Controls: click button or press C to cycle cameras`);
    });

    (bot as any).viewer.close = () => {
      httpServer.close();
      for (const s of sockets) s.disconnect();
    };
  } catch (err: any) {
    console.error("[Viewer] Failed to start viewer:", err.message || err);
  }
}
