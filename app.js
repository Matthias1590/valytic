const API_BASE = "https://replay-api.matthiasx95.workers.dev";

const fileInput = document.getElementById("file-input");
const dropzone = document.getElementById("dropzone");
const queueElement = document.getElementById("queue");
const pathButton = document.getElementById("path-button");

const replayPath = pathButton.textContent;

const MAX_CONCURRENT_UPLOADS = 1;
const UPLOAD_INTERVAL = 1000;

const queue = [];
let processing = false;
let lastUploadStart = 0;


pathButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(replayPath);

    pathButton.textContent = "Copied";

    setTimeout(() => {
        pathButton.innerHTML = `<code>${replayPath}</code>`;
    }, 1200);
});


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function formatError(error) {
    if (error instanceof Error) {
        return error.message;
    }

    return "Something went wrong.";
}


function createFileElement(file) {
    const element = document.createElement("div");
    element.className = "file";

    element.innerHTML = `
        <div class="file-top">
            <div class="file-name"></div>
            <div class="file-status">Waiting</div>
        </div>

        <div class="progress">
            <div class="progress-bar"></div>
        </div>
    `;

    element.querySelector(".file-name").textContent = file.name;

    queueElement.appendChild(element);

    return {
        element,
        status: element.querySelector(".file-status"),
        progress: element.querySelector(".progress-bar"),
    };
}


function addFiles(files) {
    for (const file of files) {
        if (!file.name.toLowerCase().endsWith(".vrf")) {
            continue;
        }

        const item = {
            file,
            ui: createFileElement(file),
        };

        queue.push(item);
    }

    processQueue();
}


fileInput.addEventListener("change", () => {
    addFiles(fileInput.files);

    // Allow selecting the same file again.
    fileInput.value = "";
});


dropzone.addEventListener("dragover", event => {
    event.preventDefault();
    dropzone.classList.add("dragging");
});


dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragging");
});


dropzone.addEventListener("drop", event => {
    event.preventDefault();
    dropzone.classList.remove("dragging");

    addFiles(event.dataTransfer.files);
});


async function sha256(file) {
    const buffer = await file.arrayBuffer();

    const digest = await crypto.subtle.digest(
        "SHA-256",
        buffer
    );

    const bytes = new Uint8Array(digest);

    return [...bytes]
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}


async function createUploaderToken() {
    const response = await fetch(`${API_BASE}/uploaders`, {
        method: "POST",
    });

    if (response.status === 429) {
        throw new RateLimitError();
    }

    if (!response.ok) {
        throw new Error(
            `Could not create uploader token (${response.status})`
        );
    }

    const body = await response.json();

    return body.token;
}


async function requestUpload(token, hash, size) {
    const response = await fetch(`${API_BASE}/upload`, {
        method: "POST",

        headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        },

        body: JSON.stringify({
            hash,
            size,
        }),
    });

    if (response.status === 429) {
        throw new RateLimitError();
    }

    if (response.status === 409) {
        throw new DuplicateError();
    }

    if (!response.ok) {
        let error = `Upload request failed (${response.status})`;

        try {
            const body = await response.json();

            if (body.error) {
                error = body.error;
            }
        } catch {
            // Ignore invalid error response.
        }

        throw new Error(error);
    }

    const body = await response.json();

    return body.upload_url;
}


function uploadToR2(url, file, checksum, token, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.open("PUT", url);

        xhr.setRequestHeader(
            "x-amz-checksum-sha256",
            checksum
        );

        xhr.setRequestHeader(
            "x-amz-meta-uploader-token",
            token
        );

        xhr.upload.addEventListener("progress", event => {
            if (!event.lengthComputable) {
                return;
            }

            onProgress(
                (event.loaded / event.total) * 100
            );
        });

        xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
                return;
            }

            reject(
                new Error(
                    `R2 rejected the upload (${xhr.status})`
                )
            );
        });

        xhr.addEventListener("error", () => {
            reject(new Error("Network error"));
        });

        xhr.addEventListener("abort", () => {
            reject(new Error("Upload cancelled"));
        });

        xhr.send(file);
    });
}


class RateLimitError extends Error {
    constructor() {
        super("Rate limited");
        this.name = "RateLimitError";
    }
}


class DuplicateError extends Error {
    constructor() {
        super("Replay already exists");
        this.name = "DuplicateError";
    }
}


async function withBackoff(fn) {
    const maxAttempts = 7;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            if (!(error instanceof RateLimitError)) {
                throw error;
            }

            const delay = Math.min(
                1000 * Math.pow(2, attempt),
                30000
            );

            await sleep(delay);
        }
    }

    throw new Error("Rate limit persisted for too long.");
}


async function processFile(item) {
    const { file, ui } = item;

    try {
        ui.status.textContent = "Checking…";
        ui.status.className = "file-status uploading";

        const hash = await sha256(file);

        /*
         * This is the checksum R2 will independently verify.
         */
        const checksumBytes = Uint8Array.from(
            hash.match(/.{2}/g),
            byte => parseInt(byte, 16)
        );

        const checksum = btoa(
            String.fromCharCode(...checksumBytes)
        );

        /*
         * Token creation and the upload gate are both
         * retried automatically if Cloudflare rate-limits us.
         */
        const token = await withBackoff(
            () => createUploaderToken()
        );

        const uploadUrl = await withBackoff(
            () => requestUpload(
                token,
                hash,
                file.size
            )
        );

        ui.status.textContent = "Uploading…";

        await uploadToR2(
            uploadUrl,
            file,
            checksum,
            token,
            percent => {
                ui.progress.style.width = `${percent}%`;
            }
        );

        ui.progress.style.width = "100%";
        ui.status.textContent = "Uploaded";
        ui.status.className = "file-status success";

    } catch (error) {
        if (error instanceof DuplicateError) {
            ui.status.textContent = "Already uploaded";
            ui.status.className = "file-status success";
            ui.progress.style.width = "100%";
            return;
        }

        ui.status.textContent = formatError(error);
        ui.status.className = "file-status error";
    }
}


async function processQueue() {
    if (processing) {
        return;
    }

    processing = true;

    while (queue.length > 0) {
        const item = queue.shift();

        const elapsed = Date.now() - lastUploadStart;

        if (elapsed < UPLOAD_INTERVAL) {
            await sleep(UPLOAD_INTERVAL - elapsed);
        }

        lastUploadStart = Date.now();

        await processFile(item);
    }

    processing = false;
}

