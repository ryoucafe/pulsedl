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

const flacQualities = [{ value: "0", label: "Lossless" }];

const bestQualities = [{ value: "best", label: "Best available" }];

const qualitiesByFormat = {
    best: bestQualities,
    mp4: videoQualities,
    mp3: audioQualities,
    flac: flacQualities
};

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
    setText("progressStage", progress.stage ? formatStage(progress.stage, progress.item) : "Idle");

    const progressFill = document.getElementById("progressFill");
    if (progressFill) {
        progressFill.style.width = percent;
    }
}

function formatStage(stage, item) {
    const stageLabels = {
        starting: "Starting",
        downloading: "Downloading",
        processing: "Processing",
        extracting: "Extracting",
        updating: "Updating",
        done: "Done",
        error: "Error"
    };
    const label = stageLabels[stage] || "Idle";
    return item ? `${label} (${item})` : label;
}

function setStatus(message, type) {
    const resultElement = document.getElementById("backendResult");
    if (resultElement) {
        resultElement.textContent = message;
        resultElement.classList.toggle("is-error", type === "error");
        resultElement.classList.toggle("is-success", type === "success");
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
    const options = qualitiesByFormat[format] || bestQualities;
    for (const item of options) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        qualitySelect.appendChild(option);
    }
    qualitySelect.disabled = options.length <= 1;
}

function createRequestId() {
    return `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const formatSelect = document.getElementById("formatSelect");
const qualitySelect = document.getElementById("qualitySelect");
const outputDirInput = document.getElementById("outputDirInput");
const filenameTemplateInput = document.getElementById("filenameTemplateInput");
const browseFolderButton = document.getElementById("browseFolderButton");
const downloadButton = document.getElementById("downloadButton");
const pasteDownloadButton = document.getElementById("pasteDownloadButton");
const urlInput = document.getElementById("urlInput");
const updateDepsButton = document.getElementById("updateDepsButton");

let isDownloading = false;
let dependenciesBusy = false;

populateQualityOptions(formatSelect.value);
setProgress({ percent: 0 });

if (!window.pulseDlApi) {
    setStatus("Start the app with Electron to enable downloads.", "error");
} else {
    setStatus("Ready for a new download.");
    loadSavedSettings();
    getApi().onDependencyProgress(handleDependencyProgress);
    prepareDependencies();
}

function updateButtons() {
    downloadButton.disabled = isDownloading || dependenciesBusy;
    pasteDownloadButton.disabled = isDownloading || dependenciesBusy;
    updateDepsButton.disabled = isDownloading || dependenciesBusy;
}

function describeDependency(info) {
    if (!info || !info.installed) {
        return "Not installed";
    }
    const source = info.source === "app" ? "built-in" : "system";
    return `${info.version} (${source})`;
}

function renderDependencies(dependencies) {
    const byName = {};
    for (const info of dependencies || []) {
        byName[info.name] = info;
    }
    setText("ytDlpVersion", describeDependency(byName["yt-dlp"]));
    setText("ffmpegVersion", describeDependency(byName.ffmpeg));
}

function setDepsStatus(message, type) {
    const element = document.getElementById("depsStatus");
    if (element) {
        element.textContent = message;
        element.classList.toggle("is-error", type === "error");
        element.classList.toggle("is-success", type === "success");
    }
}

function handleDependencyProgress(progress) {
    let message;
    if (progress.stage === "downloading") {
        const percent = typeof progress.percent === "number" ? ` ${progress.percent.toFixed(0)}%` : "";
        message = `Downloading ${progress.name}...${percent}`;
    } else if (progress.stage === "extracting") {
        message = `Extracting ${progress.name}...`;
    } else if (progress.stage === "updating") {
        message = progress.message || `Updating ${progress.name}...`;
    } else if (progress.stage === "done") {
        message = progress.message || `${progress.name} is ready.`;
    } else {
        message = `${progress.name}: ${progress.message || "failed"}`;
    }

    const type = progress.stage === "error" ? "error" : undefined;
    setDepsStatus(message, type);
    setStatus(message, type);

    setProgress({
        percent: progress.stage === "done" ? 100 : progress.percent,
        speed: progress.stage === "downloading" ? progress.speed : "-",
        eta: progress.stage === "downloading" ? progress.eta : "-",
        stage: progress.stage,
        item: progress.name
    });
}

async function runDependencyTask(task, successMessage) {
    dependenciesBusy = true;
    updateButtons();
    try {
        const result = await task();
        renderDependencies(result.dependencies);
        const ytDlp = result.dependencies.find(function(info) { return info.name === "yt-dlp"; });

        if (result.errors.length > 0) {
            const message = `Dependency problem: ${result.errors.join(" | ")}`;
            setDepsStatus(message, "error");
            if (ytDlp && ytDlp.installed) {
                // A fallback copy still works, so downloads can go ahead.
                setStatus("Ready for a new download.");
                setProgress({ percent: 0 });
            } else {
                setStatus(message, "error");
            }
        } else {
            setDepsStatus(successMessage, "success");
            setStatus("Ready for a new download.");
            // Leave a finished bar visible briefly, then return to idle.
            scheduleCompletionReset();
        }
    } catch (error) {
        const message = `Dependency error: ${getErrorMessage(error)}`;
        setDepsStatus(message, "error");
        setStatus(message, "error");
        console.error("Dependency task failed:", error);
    } finally {
        dependenciesBusy = false;
        updateButtons();
    }
}

function prepareDependencies() {
    setDepsStatus("Checking yt-dlp and ffmpeg...");
    return runDependencyTask(function() { return getApi().prepareDependencies(); }, "yt-dlp and ffmpeg are ready.");
}

updateDepsButton.addEventListener("click", function() {
    setDepsStatus("Updating yt-dlp and ffmpeg...");
    runDependencyTask(function() { return getApi().updateDependencies(); }, "yt-dlp and ffmpeg are up to date.");
});

async function loadSavedSettings() {
    try {
        const settings = await getApi().getSettings();
        if (!settings) {
            return;
        }
        if (typeof settings.outputDir === "string" && !outputDirInput.value) {
            outputDirInput.value = settings.outputDir;
        }
        if (typeof settings.filenameTemplate === "string" && settings.filenameTemplate) {
            filenameTemplateInput.value = settings.filenameTemplate;
        }
    } catch (error) {
        console.error("Failed to load settings:", error);
    }
}

async function saveSettings() {
    try {
        await getApi().saveSettings({
            outputDir: outputDirInput.value.trim(),
            filenameTemplate: filenameTemplateInput.value.trim()
        });
    } catch (error) {
        console.error("Failed to save settings:", error);
    }
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
            await saveSettings();
        }
    } catch (error) {
        setStatus(`Folder error: ${getErrorMessage(error)}`, "error");
        console.error("Failed to choose folder:", error);
    }
});

outputDirInput.addEventListener("change", saveSettings);
filenameTemplateInput.addEventListener("change", saveSettings);

downloadButton.addEventListener("click", startDownload);

urlInput.addEventListener("keydown", function(event) {
    if (event.key === "Enter" && !downloadButton.disabled) {
        event.preventDefault();
        startDownload();
    }
});

pasteDownloadButton.addEventListener("click", async function() {
    try {
        const text = (await getApi().readClipboard()).trim();
        if (!/^https?:\/\/\S+$/i.test(text)) {
            setStatus("The clipboard does not contain a link.", "error");
            return;
        }
        urlInput.value = text;
        await startDownload();
    } catch (error) {
        setStatus(`Clipboard error: ${getErrorMessage(error)}`, "error");
        console.error("Failed to read clipboard:", error);
    }
});

async function startDownload() {
    if (isDownloading || dependenciesBusy) {
        return;
    }

    let unsubscribe = null;
    try {
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
        isDownloading = true;
        updateButtons();

        unsubscribe = getApi().onDownloadProgress(function(progress) {
            if (progress.requestId !== requestId) {
                return;
            }

            if (progress.stage === "downloading") {
                setProgress(progress);
            } else if (progress.stage === "done") {
                setProgress({ percent: 100, speed: "-", eta: "-", stage: "done" });
            } else if (progress.stage === "processing" || progress.stage === "starting") {
                setText("progressStage", formatStage(progress.stage, progress.item));
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
        isDownloading = false;
        updateButtons();
    }
}
