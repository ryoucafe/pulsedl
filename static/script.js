function getErrorMessage(error) {
    if (error && typeof error.message === "string") {
        return error.message;
    }
    return String(error);
}

function getApi() {
    if (!window.pulseDlApi) {
        throw new Error("Electron preload API is unavailable. Start the app with Electron.");
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

function setText(id, value) {
    document.getElementById(id).textContent = value;
}

function setProgress(progress) {
    const percent = typeof progress.percent === "number" ? `${progress.percent.toFixed(1)}%` : "0%";
    setText("progressPercent", percent);
    setText("progressSpeed", progress.speed || "-");
    setText("progressEta", progress.eta || "-");
}

function populateQualityOptions(format) {
    const qualitySelect = document.getElementById("qualitySelect");
    qualitySelect.innerHTML = "";

    const options = format === "mp3" ? audioQualities : videoQualities;
    for (const item of options) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        qualitySelect.appendChild(option);
    }
}

function createRequestId() {
    return `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function test() {
    document.getElementById("result").innerHTML = "Message from JS file!";
}

const formatSelect = document.getElementById("formatSelect");
const qualitySelect = document.getElementById("qualitySelect");
const outputDirInput = document.getElementById("outputDirInput");
const browseFolderButton = document.getElementById("browseFolderButton");
const downloadButton = document.getElementById("downloadButton");

populateQualityOptions(formatSelect.value);

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
        console.error("Failed to choose folder:", error);
    }
});

document.getElementById("callBackend").addEventListener("click", async function() {
    const resultElement = document.getElementById("backendResult");

    try {
        const data = await getApi().ping();
        resultElement.innerHTML = `Response from backend: ${data.message}`;
    } catch (error) {
        resultElement.innerHTML = `Error: ${getErrorMessage(error)}`;
        console.error(error);
    }
});

downloadButton.addEventListener("click", async function() {
    let unsubscribe = null;
    try {
        const urlInput = document.getElementById("urlInput");
        const filenameTemplateInput = document.getElementById("filenameTemplateInput");
        const userUrl = urlInput.value.trim();
        const resultElement = document.getElementById("backendResult");
        const requestId = createRequestId();

        if (!userUrl) {
            resultElement.innerHTML = "Please enter a URL first.";
            return;
        }

        setProgress({ percent: 0 });
        resultElement.innerHTML = "Downloading... Please wait.";
        downloadButton.disabled = true;

        unsubscribe = getApi().onDownloadProgress(function(progress) {
            if (progress.requestId !== requestId) {
                return;
            }

            if (progress.stage === "downloading") {
                setProgress(progress);
            } else if (progress.stage === "done") {
                setProgress({ percent: 100, speed: "-", eta: "-" });
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

        resultElement.innerHTML = `Response from backend: ${data.message}`;
        console.log("Backend replied:", data);
    } catch (error) {
        const resultElement = document.getElementById("backendResult");
        resultElement.innerHTML = `Error during download: ${getErrorMessage(error)}`;
        console.error("Error during download:", error);
    } finally {
        if (unsubscribe) {
            unsubscribe();
        }
        downloadButton.disabled = false;
    }
});
