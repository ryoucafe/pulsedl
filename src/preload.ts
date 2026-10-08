import { contextBridge, ipcRenderer } from "electron";

type ApiResponse = {
  requestId?: string;
  status: "success" | "error";
  message: string;
};

type DownloadRequest = {
  requestId: string;
  url: string;
  format: "best" | "mp4" | "mp3" | "flac";
  quality?: string;
  outputDir?: string;
  filenameTemplate?: string;
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
};

type DependencyInfo = {
  name: "yt-dlp" | "ffmpeg";
  installed: boolean;
  source: "app" | "system" | null;
  version?: string;
};

type DependencyResult = {
  dependencies: DependencyInfo[];
  errors: string[];
};

type DependencyProgress = {
  name: "yt-dlp" | "ffmpeg";
  stage: "downloading" | "extracting" | "updating" | "done" | "error";
  percent?: number;
  speed?: string;
  eta?: string;
  message?: string;
};

contextBridge.exposeInMainWorld("pulseDlApi", {
  readClipboard: (): Promise<string> => ipcRenderer.invoke("read-clipboard"),
  getDependencyStatus: (): Promise<DependencyInfo[]> => ipcRenderer.invoke("deps-status"),
  prepareDependencies: (): Promise<DependencyResult> => ipcRenderer.invoke("deps-startup"),
  updateDependencies: (): Promise<DependencyResult> => ipcRenderer.invoke("deps-update"),
  onDependencyProgress: (callback: (progress: DependencyProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DependencyProgress) => {
      callback(payload);
    };
    ipcRenderer.on("deps-progress", listener);
    return () => {
      ipcRenderer.removeListener("deps-progress", listener);
    };
  },
  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke("choose-output-dir"),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: AppSettings): Promise<AppSettings> => ipcRenderer.invoke("save-settings", settings),
  download: (request: DownloadRequest): Promise<ApiResponse> => ipcRenderer.invoke("download", request),
  onDownloadProgress: (callback: (progress: DownloadProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DownloadProgress) => {
      callback(payload);
    };
    ipcRenderer.on("download-progress", listener);
    return () => {
      ipcRenderer.removeListener("download-progress", listener);
    };
  }
});
