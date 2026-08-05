function getErrorMessage(error) {
    if (error && typeof error.message === "string") {
        return error.message;
    }
    return String(error);
}

function getApi() {
    if (!window.pulseDlApi) {
        throw new Error("Electron API is unavailable. Start the app with Electron.");
    }
    return window.pulseDlApi;
}

const videoQualities = [
    { value: "best", label: "Best available" },
    { value: "1080", label: "1080p" },
    { value: "720", label: "720p" },
    { value: "480", label: "480p" }
];

const audioQualities = [
    { value: "320K", label: "320 kbps" },
    { value: "256K", label: "256 kbps" },
    { value: "192K", label: "192 kbps" },
    { value: "128K", label: "128 kbps" }
];

const flacQualities = [{ value: "best", label: "FLAC"}]

let completionResetTimer = null;

function setText(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function setProgress(progress) {
    const rawPercent = typeof progress.percent === "number" ? progress.percent : 0;
    const boundedPercent = Math.max(0, Math.min(100, rawPercent));
    const percent = `${boundedPercent.toFixed(1)}%`;
    setText("progressPercent", percent);
    setText("progressSpeed", progress.speed || "-");
    setText("progressEta", progress.eta || "-");
    setText("progressStage", progress.stage ? formatStage(progress.stage) : "Idle");

    const progressFill = document.getElementById("progressFill");
    if (progressFill) {
        progressFill.style.width = percent;
    }
}

function formatStage(stage) {
    const stageLabels = {
        starting: "Starting",
        downloading: "Downloading",
        processing: "Processing",
        done: "Done",
        error: "Error"
    };
    return stageLabels[stage] || "Idle";
}

function setStatus(message, type) {
    const resultElement = document.getElementById("backendResult");
    if (resultElement) {
        resultElement.textContent = message;
    }
}

function scheduleCompletionReset() {
    if (completionResetTimer) {
        window.clearTimeout(completionResetTimer);
    }

    completionResetTimer = window.setTimeout(function() {
        setStatus("Ready for a new download.");
        setProgress({ percent: 0 });
        completionResetTimer = null;
    }, 3500);
}

function showView(viewId) {
    document.querySelectorAll(".app-view").forEach(function(view) {
        const isActive = view.id === viewId;
        view.hidden = !isActive;
        view.classList.toggle("active", isActive);
    });

    document.querySelectorAll("[data-view-target]").forEach(function(button) {
        button.classList.toggle("active", button.dataset.viewTarget === viewId);
    });
}

function populateQualityOptions(format) {
    const qualitySelect = document.getElementById("qualitySelect");
    qualitySelect.innerHTML = "";
    if (format !== "flac" || format !== "best") {
      const options = format === "mp3" ? audioQualities : videoQualities;
      for (const item of options) {
          const option = document.createElement("option");
          option.value = item.value;
          option.textContent = item.label;
          qualitySelect.appendChild(option);
      }
    }
}

function createRequestId() {
    return `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function test() {
    setText("result", "Message from JS file!");
}

const formatSelect = document.getElementById("formatSelect");
const qualitySelect = document.getElementById("qualitySelect");
const outputDirInput = document.getElementById("outputDirInput");
const browseFolderButton = document.getElementById("browseFolderButton");
const downloadButton = document.getElementById("downloadButton");

populateQualityOptions(formatSelect.value);
setProgress({ percent: 0 });

if (!window.pulseDlApi) {
    setStatus("Start the app with Electron to enable downloads.", "error");
} else {
    setStatus("Ready for a new download.", "success");
}

document.querySelectorAll("[data-view-target]").forEach(function(button) {
    button.addEventListener("click", function() {
        showView(button.dataset.viewTarget);
    });
});

formatSelect.addEventListener("change", function() {
    populateQualityOptions(formatSelect.value);
});

browseFolderButton.addEventListener("click", async function() {
    try {
        const selected = await getApi().chooseOutputDir();
        if (selected) {
            outputDirInput.value = selected;
        }
    } catch (error) {
        setStatus(`Folder error: ${getErrorMessage(error)}`, "error");
        console.error("Failed to choose folder:", error);
    }
});

document.getElementById("callBackend").addEventListener("click", async function() {
    try {
        const data = await getApi().ping();
        setStatus(`Backend: ${data.message}`, "success");
    } catch (error) {
        setStatus(`Error: ${getErrorMessage(error)}`, "error");
        console.error(error);
    }
});

downloadButton.addEventListener("click", async function() {
    let unsubscribe = null;
    try {
        const urlInput = document.getElementById("urlInput");
        const filenameTemplateInput = document.getElementById("filenameTemplateInput");
        const userUrl = urlInput.value.trim();
        const requestId = createRequestId();

        if (!userUrl) {
            setStatus("Enter a URL before starting the download.");
            urlInput.focus();
            return;
        }

        if (completionResetTimer) {
            window.clearTimeout(completionResetTimer);
            completionResetTimer = null;
        }

        setProgress({ percent: 0, stage: "starting" });
        setStatus("Download in progress...");
        downloadButton.disabled = true;

        unsubscribe = getApi().onDownloadProgress(function(progress) {
            if (progress.requestId !== requestId) {
                return;
            }

            if (progress.stage === "downloading") {
                setProgress(progress);
            } else if (progress.stage === "done") {
                setProgress({ percent: 100, speed: "-", eta: "-", stage: "done" });
            } else if (progress.stage === "processing" || progress.stage === "starting") {
                setText("progressStage", formatStage(progress.stage));
            } else if (progress.stage === "error") {
                setProgress({ percent: 0, speed: "-", eta: "-", stage: "error" });
            }
        });

        const data = await getApi().download({
            requestId: requestId,
            url: userUrl,
            format: formatSelect.value,
            quality: qualitySelect.value,
            outputDir: outputDirInput.value.trim(),
            filenameTemplate: filenameTemplateInput.value.trim()
        });

        setStatus(data.message, data.status === "error" ? "error" : "success");
        if (data.status === "success") {
            scheduleCompletionReset();
        }
        console.log("Backend replied:", data);
    } catch (error) {
        setStatus(`Download error: ${getErrorMessage(error)}`, "error");
        setProgress({ percent: 0, speed: "-", eta: "-", stage: "error" });
        console.error("Error during download:", error);
    } finally {
        if (unsubscribe) {
            unsubscribe();
        }
        downloadButton.disabled = false;
    }
});
