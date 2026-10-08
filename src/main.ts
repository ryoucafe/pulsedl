import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DependencyInfo,
  DependencyProgress,
  getBinDir,
  getDependencyStatus,
  hasManagedFfmpeg,
  installMissingDependencies,
  isDependencyBusy,
  resolveCommand,
  updateAllDependencies,
  updateYtDlpOnly
} from "./deps";

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
  item?: string;
  raw?: string;
};

type AppSettings = {
  outputDir?: string;
  filenameTemplate?: string;
  lastYtDlpUpdateCheck?: number;
};

type DependencyResult = {
  dependencies: DependencyInfo[];
  errors: string[];
};

const YT_DLP_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let activeDownloads = 0;

const getSettingsPath = (): string => path.join(app.getPath("userData"), "settings.json");

const loadSettings = (): AppSettings => {
  try {
    const parsed = JSON.parse(fs.readFileSync(getSettingsPath(), "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const saveSettings = (settings: AppSettings): void => {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
};

const sanitizeFilenameTemplate = (template: string | undefined): string => {
  const trimmed = (template ?? "").trim();
  return trimmed || "%(title)s.%(ext)s";
};

const isDirectory = (dirPath: string): boolean => {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
};

const buildYtDlpArgs = (request: DownloadRequest): string[] => {
  const args: string[] = ["--newline"];
  const outputTemplate = sanitizeFilenameTemplate(request.filenameTemplate);
  args.push("-o", outputTemplate);
  args.push("--embed-metadata","--embed-thumbnail");

  if (request.format === "mp3") {
    args.push("-x", "--audio-format", "mp3");
    const audioQuality = (request.quality ?? "").trim();
    if (/^\d+K$/i.test(audioQuality)) {
      args.push("--audio-quality", audioQuality);
    }
  } else if (request.format === "mp4") {
    const quality = (request.quality ?? "").trim();
    if (/^\d+$/.test(quality)) {
      args.push("-f", `bv*[ext=mp4][height<=${quality}]+ba[ext=m4a]/b[ext=mp4][height<=${quality}]`);
    } else {
      args.push("-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]");
    }
  } else if (request.format === "flac") {
    // FLAC is lossless; 0 = best quality.
    args.push("-x", "--audio-format", "flac", "--audio-quality", "0");
  }

  if (hasManagedFfmpeg()) {
    args.push("--ffmpeg-location", getBinDir());
  }

  if (request.format === "mp3" || request.format === "flac") {
    args.push("--parse-metadata", 'uploader:%(artist)s', "--parse-metadata", 'playlist_index:%(track_number)s');
  }
  // "--" stops option parsing so a URL starting with "-" can't be read as a yt-dlp flag.
  args.push("--", request.url.trim());
  return args;
};

// Splits a stream into complete lines, holding back a partial line until the next chunk.
const createLineReader = (onLine: (line: string) => void) => {
  let pending = "";
  return {
    push: (chunk: Buffer): void => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          onLine(trimmed);
        }
      }
    },
    flush: (): void => {
      const trimmed = pending.trim();
      pending = "";
      if (trimmed) {
        onLine(trimmed);
      }
    }
  };
};

// Tracks playlist items and per-item parts (e.g. video + audio) so overall progress only moves forward.
const createProgressTracker = () => {
  let itemIndex = 1;
  let itemCount = 1;
  let partIndex = 0;
  let partCount = 1;

  return {
    handleLine: (line: string): void => {
      const itemMatch = line.match(/^\[download\] Downloading item (\d+) of (\d+)/);
      if (itemMatch) {
        itemIndex = Number.parseInt(itemMatch[1], 10);
        itemCount = Math.max(1, Number.parseInt(itemMatch[2], 10));
        partIndex = 0;
        partCount = 1;
        return;
      }

      const formatMatch = line.match(/Downloading \d+ format\(s\):\s*(\S+)/);
      if (formatMatch) {
        partIndex = 0;
        partCount = formatMatch[1].split("+").length;
        return;
      }

      if (/^\[download\] Destination:/.test(line) || /^\[download\] .+ has already been downloaded/.test(line)) {
        partIndex += 1;
        partCount = Math.max(partCount, partIndex);
      }
    },
    overallPercent: (partPercent: number): number => {
      const currentPart = Math.max(partIndex, 1) - 1;
      const itemFraction = (currentPart + partPercent / 100) / partCount;
      return ((itemIndex - 1 + itemFraction) / itemCount) * 100;
    },
    itemLabel: (): string | undefined => (itemCount > 1 ? `${itemIndex} of ${itemCount}` : undefined)
  };
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

  ipcMain.handle("get-settings", async (): Promise<AppSettings> => {
    return loadSettings();
  });

  ipcMain.handle("save-settings", async (_event, partial: AppSettings): Promise<AppSettings> => {
    const merged: AppSettings = { ...loadSettings() };
    if (typeof partial?.outputDir === "string") {
      merged.outputDir = partial.outputDir.trim();
    }
    if (typeof partial?.filenameTemplate === "string") {
      merged.filenameTemplate = partial.filenameTemplate.trim();
    }
    saveSettings(merged);
    return merged;
  });

  ipcMain.handle("read-clipboard", async (): Promise<string> => {
    return clipboard.readText();
  });

  ipcMain.handle("deps-status", async (): Promise<DependencyInfo[]> => {
    return getDependencyStatus();
  });

  // First launch installs anything missing; after that yt-dlp is refreshed at most once a day.
  ipcMain.handle("deps-startup", async (event): Promise<DependencyResult> => {
    const onProgress = (progress: DependencyProgress) => event.sender.send("deps-progress", progress);
    try {
      const errors = await installMissingDependencies(onProgress);

      const settings = loadSettings();
      const lastCheck = settings.lastYtDlpUpdateCheck ?? 0;
      if (errors.length === 0 && Date.now() - lastCheck > YT_DLP_UPDATE_INTERVAL_MS) {
        errors.push(...(await updateYtDlpOnly(onProgress)));
        if (errors.length === 0) {
          saveSettings({ ...loadSettings(), lastYtDlpUpdateCheck: Date.now() });
        }
      }
      return { dependencies: await getDependencyStatus(), errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { dependencies: await getDependencyStatus(), errors: [message] };
    }
  });

  ipcMain.handle("deps-update", async (event): Promise<DependencyResult> => {
    if (activeDownloads > 0) {
      return { dependencies: await getDependencyStatus(), errors: ["Wait for the current download to finish before updating."] };
    }
    const onProgress = (progress: DependencyProgress) => event.sender.send("deps-progress", progress);
    try {
      const errors = await updateAllDependencies(onProgress);
      if (errors.length === 0) {
        saveSettings({ ...loadSettings(), lastYtDlpUpdateCheck: Date.now() });
      }
      return { dependencies: await getDependencyStatus(), errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { dependencies: await getDependencyStatus(), errors: [message] };
    }
  });

  ipcMain.handle("download", async (event, request: DownloadRequest): Promise<DownloadResult> => {
    const trimmed = typeof request.url === "string" ? request.url.trim() : "";
    if (!trimmed) {
      return { requestId: request.requestId, status: "error", message: "URL is required." };
    }

    if (isDependencyBusy()) {
      return { requestId: request.requestId, status: "error", message: "yt-dlp and ffmpeg are being updated. Try again in a moment." };
    }

    const outputDir = (request.outputDir ?? "").trim() || app.getPath("downloads");
    if (!isDirectory(outputDir)) {
      return {
        requestId: request.requestId,
        status: "error",
        message: `Output folder does not exist: ${outputDir}. Choose another folder in Settings.`
      };
    }

    activeDownloads += 1;
    return new Promise<DownloadResult>((settle) => {
      let settled = false;
      const resolve = (result: DownloadResult): void => {
        if (!settled) {
          settled = true;
          activeDownloads -= 1;
          settle(result);
        }
      };

      const args = buildYtDlpArgs(request);

      emitProgress(event, { requestId: request.requestId, stage: "starting", raw: "Starting yt-dlp..." });

      const child = spawn(resolveCommand("yt-dlp"), args, {
        cwd: outputDir,
        shell: false,
        windowsHide: true
      });

      let lastStdoutLine = "";
      let stderr = "";
      const errorLines: string[] = [];
      const tracker = createProgressTracker();

      const stdoutReader = createLineReader((line) => {
        lastStdoutLine = line;
        tracker.handleLine(line);

        const parsed = parseProgressLine(line);
        if (parsed?.percent !== undefined) {
          emitProgress(event, {
            requestId: request.requestId,
            stage: "downloading",
            percent: tracker.overallPercent(parsed.percent),
            speed: parsed.speed,
            eta: parsed.eta,
            item: tracker.itemLabel(),
            raw: line
          });
          return;
        }

        if (line.includes("[Merger]") || line.includes("[ExtractAudio]")) {
          emitProgress(event, { requestId: request.requestId, stage: "processing", item: tracker.itemLabel(), raw: line });
        }
      });

      // yt-dlp also writes WARNING lines to stderr; only ERROR lines mean the download failed.
      const stderrReader = createLineReader((line) => {
        stderr += `${line}\n`;
        if (line.startsWith("ERROR:")) {
          errorLines.push(line);
          emitProgress(event, { requestId: request.requestId, stage: "error", raw: line });
        }
      });

      child.stdout.on("data", (chunk: Buffer) => stdoutReader.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrReader.push(chunk));

      child.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          const result: DownloadResult = {
            requestId: request.requestId,
            status: "error",
            message: "yt-dlp is not installed. Open Settings and click Update dependencies."
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
        stdoutReader.flush();
        stderrReader.flush();

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

        const detail = errorLines.join("\n") || stderr.trim();
        const result: DownloadResult = {
          requestId: request.requestId,
          status: "error",
          message: detail || lastStdoutLine || `yt-dlp exited with code ${code ?? "unknown"}.`
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
