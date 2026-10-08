import { app } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export type DependencyName = "yt-dlp" | "ffmpeg";

export type DependencyInfo = {
  name: DependencyName;
  installed: boolean;
  source: "app" | "system" | null;
  version?: string;
};

export type DependencyProgress = {
  name: DependencyName;
  stage: "downloading" | "extracting" | "updating" | "done" | "error";
  percent?: number;
  speed?: string;
  eta?: string;
  message?: string;
};

type ProgressCallback = (progress: DependencyProgress) => void;

type TransferProgress = {
  percent: number;
  speed: string;
  eta: string;
};

type ArchiveSource = {
  url: string;
  binaries: string[];
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const YT_DLP_BASE_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
const FFMPEG_BASE_URL = "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/";
const FFMPEG_MAC_BASE_URL = "https://ffmpeg.martin-riedl.de/redirect/latest/macos/";

let busy = false;

export const isDependencyBusy = (): boolean => busy;

export const getBinDir = (): string => path.join(app.getPath("userData"), "bin");

const executableName = (name: string): string => (process.platform === "win32" ? `${name}.exe` : name);

const managedPath = (name: string): string => path.join(getBinDir(), executableName(name));

const hasManaged = (name: string): boolean => fs.existsSync(managedPath(name));

// Prefer the copy the app manages; fall back to whatever is on PATH.
export const resolveCommand = (name: "yt-dlp" | "ffmpeg"): string => (hasManaged(name) ? managedPath(name) : name);

export const hasManagedFfmpeg = (): boolean => hasManaged("ffmpeg") && hasManaged("ffprobe");

const ytDlpUrl = (): string => {
  if (process.platform === "win32") {
    return `${YT_DLP_BASE_URL}yt-dlp.exe`;
  }
  if (process.platform === "darwin") {
    return `${YT_DLP_BASE_URL}yt-dlp_macos`;
  }
  if (process.platform === "linux") {
    return `${YT_DLP_BASE_URL}${process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux"}`;
  }
  throw new Error(`yt-dlp downloads are not available for ${process.platform}.`);
};

const ffmpegSources = (): ArchiveSource[] => {
  const arm = process.arch === "arm64";
  if (process.platform === "win32") {
    return [{ url: `${FFMPEG_BASE_URL}ffmpeg-master-latest-${arm ? "winarm64" : "win64"}-gpl.zip`, binaries: ["ffmpeg", "ffprobe"] }];
  }
  if (process.platform === "linux") {
    return [{ url: `${FFMPEG_BASE_URL}ffmpeg-master-latest-${arm ? "linuxarm64" : "linux64"}-gpl.tar.xz`, binaries: ["ffmpeg", "ffprobe"] }];
  }
  if (process.platform === "darwin") {
    const macArch = arm ? "arm64" : "amd64";
    return [
      { url: `${FFMPEG_MAC_BASE_URL}${macArch}/release/ffmpeg.zip`, binaries: ["ffmpeg"] },
      { url: `${FFMPEG_MAC_BASE_URL}${macArch}/release/ffprobe.zip`, binaries: ["ffprobe"] }
    ];
  }
  throw new Error(`ffmpeg downloads are not available for ${process.platform}.`);
};

const runCommand = (command: string, args: string[]): Promise<CommandResult> => {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { shell: false, windowsHide: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: null, stdout, stderr: stderr || error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
};

const readVersion = async (name: DependencyName, command: string): Promise<string | undefined> => {
  if (name === "yt-dlp") {
    const result = await runCommand(command, ["--version"]);
    return result.code === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
  }

  const result = await runCommand(command, ["-version"]);
  if (result.code !== 0) {
    return undefined;
  }
  return result.stdout.match(/ffmpeg version (\S+)/)?.[1] ?? "unknown";
};

const getDependencyInfo = async (name: DependencyName): Promise<DependencyInfo> => {
  const managed = name === "ffmpeg" ? hasManagedFfmpeg() : hasManaged(name);
  if (managed) {
    const version = await readVersion(name, managedPath(name));
    if (version) {
      return { name, installed: true, source: "app", version };
    }
  }

  const systemVersion = await readVersion(name, name);
  if (systemVersion) {
    return { name, installed: true, source: "system", version: systemVersion };
  }
  return { name, installed: false, source: null };
};

export const getDependencyStatus = async (): Promise<DependencyInfo[]> => {
  return Promise.all([getDependencyInfo("yt-dlp"), getDependencyInfo("ffmpeg")]);
};

const formatSpeed = (bytesPerSecond: number): string => {
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
};

const formatEta = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "-";
  }
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

// Progress is reported at most every PROGRESS_INTERVAL_MS so the renderer isn't flooded with IPC messages.
const PROGRESS_INTERVAL_MS = 150;

const downloadFile = async (url: string, destination: string, onProgress: (progress: TransferProgress) => void): Promise<void> => {
  let lastError: unknown;
  // Mirrors occasionally return a transient 404/5xx, so retry a few times.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} while downloading ${url}`);
      }

      const total = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      const hasTotal = Number.isFinite(total) && total > 0;
      const startedAt = Date.now();
      let received = 0;
      let lastReport = 0;

      const report = (force: boolean): void => {
        const now = Date.now();
        if (!force && now - lastReport < PROGRESS_INTERVAL_MS) {
          return;
        }
        lastReport = now;
        const elapsed = Math.max((now - startedAt) / 1000, 0.001);
        const bytesPerSecond = received / elapsed;
        onProgress({
          percent: hasTotal ? Math.min((received / total) * 100, 100) : 0,
          speed: formatSpeed(bytesPerSecond),
          eta: hasTotal && bytesPerSecond > 0 ? formatEta((total - received) / bytesPerSecond) : "-"
        });
      };

      const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
      body.on("data", (chunk: Buffer) => {
        received += chunk.length;
        report(false);
      });
      body.on("end", () => report(true));

      const partial = `${destination}.part`;
      await pipeline(body, fs.createWriteStream(partial));
      fs.renameSync(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      fs.rmSync(`${destination}.part`, { force: true });
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const extractArchive = async (archive: string, destination: string): Promise<void> => {
  // bsdtar ships with Windows 10+ and macOS and reads zip; GNU tar on Linux reads tar.xz.
  const tar = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
  fs.mkdirSync(destination, { recursive: true });
  const result = await runCommand(tar, ["-xf", archive, "-C", destination]);
  if (result.code !== 0) {
    throw new Error(`Failed to extract ${path.basename(archive)}: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }
};

const findFile = (directory: string, fileName: string): string | null => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(fullPath, fileName);
      if (found) {
        return found;
      }
    } else if (entry.name === fileName) {
      return fullPath;
    }
  }
  return null;
};

const installBinary = (source: string, name: string): void => {
  const target = managedPath(name);
  const partial = `${target}.part`;
  fs.copyFileSync(source, partial);
  if (process.platform !== "win32") {
    fs.chmodSync(partial, 0o755);
  }
  fs.renameSync(partial, target);
};

const installYtDlp = async (onProgress: ProgressCallback): Promise<void> => {
  fs.mkdirSync(getBinDir(), { recursive: true });
  const target = managedPath("yt-dlp");
  await downloadFile(ytDlpUrl(), target, (transfer) => onProgress({ name: "yt-dlp", stage: "downloading", ...transfer }));
  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o755);
  }
  onProgress({ name: "yt-dlp", stage: "done", percent: 100 });
};

const installFfmpeg = async (onProgress: ProgressCallback): Promise<void> => {
  fs.mkdirSync(getBinDir(), { recursive: true });
  const workDir = fs.mkdtempSync(path.join(app.getPath("temp"), "pulsedl-ffmpeg-"));

  try {
    const sources = ffmpegSources();
    for (const [index, source] of sources.entries()) {
      const archive = path.join(workDir, path.basename(new URL(source.url).pathname));
      await downloadFile(source.url, archive, (transfer) => {
        onProgress({
          name: "ffmpeg",
          stage: "downloading",
          ...transfer,
          percent: ((index + transfer.percent / 100) / sources.length) * 100
        });
      });

      onProgress({ name: "ffmpeg", stage: "extracting", percent: ((index + 1) / sources.length) * 100 });
      const extractDir = path.join(workDir, `extract-${index}`);
      await extractArchive(archive, extractDir);

      for (const binary of source.binaries) {
        const found = findFile(extractDir, executableName(binary));
        if (!found) {
          throw new Error(`${executableName(binary)} was not found in ${path.basename(archive)}.`);
        }
        installBinary(found, binary);
      }
    }
    onProgress({ name: "ffmpeg", stage: "done", percent: 100 });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
};

const updateYtDlp = async (onProgress: ProgressCallback): Promise<void> => {
  if (!hasManaged("yt-dlp")) {
    await installYtDlp(onProgress);
    return;
  }

  onProgress({ name: "yt-dlp", stage: "updating", message: "Checking for yt-dlp updates..." });
  const result = await runCommand(managedPath("yt-dlp"), ["-U"]);
  if (result.code !== 0) {
    // Self-update can fail (e.g. GitHub rate limits); a fresh download always gets the latest build.
    await installYtDlp(onProgress);
    return;
  }
  onProgress({ name: "yt-dlp", stage: "done", percent: 100, message: result.stdout.trim().split(/\r?\n/).pop() });
};

const withLock = async <T>(task: () => Promise<T>): Promise<T> => {
  if (busy) {
    throw new Error("A dependency update is already running.");
  }
  busy = true;
  try {
    return await task();
  } finally {
    busy = false;
  }
};

const runStep = async (name: DependencyName, step: () => Promise<void>, onProgress: ProgressCallback, errors: string[]): Promise<void> => {
  try {
    await step();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${name}: ${message}`);
    onProgress({ name, stage: "error", message });
  }
};

// Installs any app-managed dependency that is missing. Existing copies are left alone.
export const installMissingDependencies = (onProgress: ProgressCallback): Promise<string[]> => {
  return withLock(async () => {
    const errors: string[] = [];
    if (!hasManaged("yt-dlp")) {
      await runStep("yt-dlp", () => installYtDlp(onProgress), onProgress, errors);
    }
    if (!hasManagedFfmpeg()) {
      await runStep("ffmpeg", () => installFfmpeg(onProgress), onProgress, errors);
    }
    return errors;
  });
};

export const updateYtDlpOnly = (onProgress: ProgressCallback): Promise<string[]> => {
  return withLock(async () => {
    const errors: string[] = [];
    await runStep("yt-dlp", () => updateYtDlp(onProgress), onProgress, errors);
    return errors;
  });
};

// Updates yt-dlp in place and downloads a fresh ffmpeg build.
export const updateAllDependencies = (onProgress: ProgressCallback): Promise<string[]> => {
  return withLock(async () => {
    const errors: string[] = [];
    await runStep("yt-dlp", () => updateYtDlp(onProgress), onProgress, errors);
    await runStep("ffmpeg", () => installFfmpeg(onProgress), onProgress, errors);
    return errors;
  });
};
