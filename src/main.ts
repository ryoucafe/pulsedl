import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import path from "node:path";

type DownloadFormat = "best" | "mp4" | "mp3" | "flac";

type DownloadRequest = {
  requestId: string;
  url: string;
  format: DownloadFormat;
  quality?: string;
  outputDir?: string;
  filenameTemplate?: string;
};

type DownloadResult = {
  requestId: string;
  status: "success" | "error";
  message: string;
};

type DownloadProgress = {
  requestId: string;
  percent?: number;
  speed?: string;
  eta?: string;
  stage: "starting" | "downloading" | "processing" | "done" | "error";
  raw?: string;
};

const sanitizeFilenameTemplate = (template: string | undefined): string => {
  const trimmed = (template ?? "").trim();
  return trimmed || "%(title)s.%(ext)s";
};

const buildYtDlpArgs = (request: DownloadRequest): string[] => {
  const args: string[] = ["--newline"];
  const outputTemplate = sanitizeFilenameTemplate(request.filenameTemplate);
  args.push("-o", outputTemplate);

  if (request.format === "mp3") {
    args.push("-x", "--audio-format", "mp3");
    const audioQuality = (request.quality ?? "").trim();
    if (audioQuality) {
      args.push("--audio-quality", audioQuality);
    }
  } else if (request.format === "mp4") {
    const quality = (request.quality ?? "").trim();
    if (quality && quality !== "best") {
      args.push("-f", `bv*[ext=mp4][height<=${quality}]+ba[ext=m4a]/b[ext=mp4]`);
    } else {
      args.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]");
    }
  } else if (request.format === "flac") {
    args.push("-x", "--audio-format", "flac");
    const audioQuality = (request.quality ?? "").trim();
    if (audioQuality) {
      args.push("--audio-quality", audioQuality);
    }
  } 

  args.push(request.url.trim());
  return args;
};

const emitProgress = (event: Electron.IpcMainInvokeEvent, payload: DownloadProgress): void => {
  event.sender.send("download-progress", payload);
};

const parseProgressLine = (line: string): { percent?: number; speed?: string; eta?: string } | null => {
  const progressMatch = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%.*?(?:at\s+(.+?)\s+)?(?:ETA\s+([0-9:]+))?$/);
  if (!progressMatch) {
    return null;
  }

  const percent = Number.parseFloat(progressMatch[1]);
  const speed = progressMatch[2]?.trim();
  const eta = progressMatch[3]?.trim();
  return {
    percent: Number.isFinite(percent) ? percent : undefined,
    speed,
    eta
  };
};

const createWindow = (): void => {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const indexPath = path.join(__dirname, "..", "templates", "index.html");
  win.loadFile(indexPath);
};

app.whenReady().then(() => {
  ipcMain.handle("choose-output-dir", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("ping", async () => {
    return {
      status: "success",
      message: "Pong! This message is from the Electron main process."
    };
  });

  ipcMain.handle("download", async (event, request: DownloadRequest): Promise<DownloadResult> => {
    const trimmed = typeof request.url === "string" ? request.url.trim() : "";
    if (!trimmed) {
      return { requestId: request.requestId, status: "error", message: "URL is required." };
    }

    return new Promise<DownloadResult>((resolve) => {
      const args = buildYtDlpArgs(request);
      const outputDir = (request.outputDir ?? "").trim() || app.getPath("downloads");

      emitProgress(event, { requestId: request.requestId, stage: "starting", raw: "Starting yt-dlp..." });

      const child = spawn("yt-dlp", args, {
        cwd: outputDir,
        shell: false
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = chunk.toString().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

        for (const line of lines) {
          const parsed = parseProgressLine(line);
          if (parsed?.percent !== undefined) {
            emitProgress(event, {
              requestId: request.requestId,
              stage: "downloading",
              percent: parsed.percent,
              speed: parsed.speed,
              eta: parsed.eta,
              raw: line
            });
            continue;
          }

          if (line.includes("[Merger]") || line.includes("[ExtractAudio]")) {
            emitProgress(event, { requestId: request.requestId, stage: "processing", raw: line });
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
          emitProgress(event, { requestId: request.requestId, stage: "error", raw: line });
        }
      });

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          const result: DownloadResult = {
            requestId: request.requestId,
            status: "error",
            message: "yt-dlp was not found in PATH. Install yt-dlp and restart the app."
          };
          emitProgress(event, { requestId: request.requestId, stage: "error", raw: result.message });
          resolve(result);
          return;
        }

        const result: DownloadResult = {
          requestId: request.requestId,
          status: "error",
          message: `Failed to start yt-dlp: ${error.message}`
        };
        emitProgress(event, { requestId: request.requestId, stage: "error", raw: result.message });
        resolve(result);
      });

      child.on("close", (code: number | null) => {
        if (code === 0) {
          const result: DownloadResult = {
            requestId: request.requestId,
            status: "success",
            message: `Download completed. Saved to ${outputDir}.`
          };
          emitProgress(event, { requestId: request.requestId, stage: "done", percent: 100, raw: "Download complete." });
          resolve(result);
          return;
        }

        const detail = stderr.trim();
        const fallback = stdout.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
        const result: DownloadResult = {
          requestId: request.requestId,
          status: "error",
          message: detail || fallback || `yt-dlp exited with code ${code ?? "unknown"}.`
        };
        emitProgress(event, { requestId: request.requestId, stage: "error", raw: result.message });
        resolve(result);
      });
    });
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
