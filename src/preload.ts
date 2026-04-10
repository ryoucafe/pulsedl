import { contextBridge, ipcRenderer } from "electron";

type ApiResponse = {
  requestId?: string;
  status: "success" | "error";
  message: string;
};

type DownloadRequest = {
  requestId: string;
  url: string;
  format: "best" | "mp4" | "mp3";
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
  raw?: string;
};

contextBridge.exposeInMainWorld("pulseDlApi", {
  ping: (): Promise<ApiResponse> => ipcRenderer.invoke("ping"),
  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke("choose-output-dir"),
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
