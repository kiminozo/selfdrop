import { useState, useEffect, useRef } from "react";
import Logo from "../components/Logo.jsx";
import FileTypeIcon from "../components/FileTypeIcon.jsx";
import PreviewModal from "../components/PreviewModal.jsx";
import { formatExpiry, isExpiringSoon } from "../utils/formatDate.js";
import { getUrl } from "../utils/downloadUtils.js";
import { getDownloadTask, saveDownloadTask, deleteDownloadTask } from "../utils/downloadTaskStore.js";

export default function Download({ uuid }) {
  const [state, setState] = useState("loading");
  const [shareInfo, setShareInfo] = useState(null);
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwLoading, setPwLoading] = useState(false);

  // Multi-file selection
  const [selected, setSelected] = useState(new Set());

  // Preview modal
  const [previewIndex, setPreviewIndex] = useState(null);

  // ZIP state
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState("");

  // Single-file download progress
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [savedTask, setSavedTask] = useState(null);
  const downloadAbortRef = useRef(null);
  const downloadActionRef = useRef(null);

  useEffect(() => {
    loadShareInfo();
  }, [uuid]);

  useEffect(() => {
    if (state !== "ready" || !shareInfo?.files) return;
    let active = true;
    Promise.all(shareInfo.files.map((file) => getDownloadTask(uuid + ":" + file.uuid)))
      .then((tasks) => {
        if (!active) return;
        const task = tasks.find(Boolean);
        setSavedTask(task || null);
        if (task) setDownloadProgress({ filename: task.filename, status: "paused", received: task.received, total: task.total });
      })
      .catch((error) => console.error("Could not restore download task:", error));
    return () => { active = false; };
  }, [state, shareInfo, uuid]);

  // Select all by default once loaded
  useEffect(() => {
    if (shareInfo?.files) {
      setSelected(new Set(shareInfo.files.map((f) => f.uuid)));
    }
  }, [shareInfo]);

  async function loadShareInfo() {
    setState("loading");
    const res = await fetch(`/s/${uuid}/info`);
    if (!res.ok) {
      setState("notfound");
      return;
    }
    const data = await res.json();
    setShareInfo(data);
    setState(data.hasPassword ? "password" : "ready");
  }

  async function handlePasswordSubmit(e) {
    e?.preventDefault();
    setPwError("");
    if (!password.trim()) {
      setPwError("Please enter the password.");
      return;
    }
    setPwLoading(true);
    const res = await fetch(`/s/${uuid}/verify-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setPwLoading(false);
    if (!res.ok) {
      setPwError("Incorrect password. Please try again.");
      setPassword("");
      return;
    }

    const data = await res.json();
    setShareInfo(data);
    setState("ready");
  }

  function toggleSelect(uuid) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(uuid) ? next.delete(uuid) : next.add(uuid);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(shareInfo.files.map((f) => f.uuid)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  async function startDownload(file, handle, offset = 0, taskId, permissionPromise = null) {
    if (downloadAbortRef.current) return;
    taskId = taskId || (uuid + ":" + file.uuid);

    let granted = false;
    try {
      const permission = permissionPromise
        ? await permissionPromise
        : await handle.queryPermission({ mode: "readwrite" });
      granted = permission === "granted" || (await handle.requestPermission({ mode: "readwrite" })) === "granted";
    } catch (error) {
      setDownloadProgress({ filename: file.filename, status: "paused", received: offset, total: Number(file.size) || 0, error: error.message || "Could not access the destination file." });
      return;
    }
    if (!granted) {
      setDownloadProgress({ filename: file.filename, status: "paused", received: offset, total: Number(file.size) || 0, error: "Allow file access to resume this download." });
      return;
    }

    const task = { id: taskId, shareUuid: uuid, fileUuid: file.uuid, filename: file.filename, total: Number(file.size) || 0, received: offset, handle, updatedAt: Date.now() };
    try {
      await saveDownloadTask(task);
    } catch (error) {
      setDownloadProgress({ filename: file.filename, status: "failed", error: "Could not save the resumable download task: " + (error.message || "IndexedDB unavailable.") });
      return;
    }
    setSavedTask(task);

    const controller = new AbortController();
    downloadAbortRef.current = controller;
    downloadActionRef.current = null;
    let writable = null;
    let received = offset;
    let lastBytes = offset;
    let lastTime = performance.now();
    let speed = 0;

    setDownloadProgress({ filename: file.filename, status: "downloading", received, total: task.total, percent: task.total ? (received / task.total) * 100 : 0, speed: 0, remaining: null });

    try {
      const url = getUrl(file, uuid, shareInfo.hasPassword);
      const headers = offset > 0 ? { Range: "bytes=" + offset + "-" } : {};
      const response = await fetch(url, { signal: controller.signal, cache: "no-store", headers });

      if (offset > 0) {
        const contentRange = response.headers.get("Content-Range") || "";
        const match = contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
        if (response.status !== 206 || !match || Number(match[1]) !== offset) {
          throw new Error("The server did not honor the resume request. The partial file was kept; try again or restart the download.");
        }
        if (task.total && Number(match[3]) !== task.total) {
          throw new Error("The shared file size changed. The partial download cannot be resumed safely.");
        }
      } else if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || "Download failed (HTTP " + response.status + ").");
      }
      if (!response.body) throw new Error("This browser did not provide a readable download stream.");

      const contentRange = response.headers.get("Content-Range") || "";
      const rangeMatch = contentRange.match(/^bytes 0-\d+\/(\d+)$/i);
      const total = offset > 0 ? task.total : (Number(rangeMatch?.[1]) || Number(response.headers.get("Content-Length")) || task.total);
      writable = await handle.createWritable({ keepExistingData: true });
      await writable.truncate(offset);
      await writable.seek(offset);
      const reader = response.body.getReader();
      let checkpoint = received;

      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const value = result.value;
        await writable.write(value);
        received += value.byteLength;

        if (received - checkpoint >= 8 * 1024 * 1024) {
          await writable.close();
          writable = null;
          task.received = received;
          task.updatedAt = Date.now();
          await saveDownloadTask(task);
          checkpoint = received;
          writable = await handle.createWritable({ keepExistingData: true });
          await writable.seek(received);
        }

        const now = performance.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed >= 0.4) {
          speed = (received - lastBytes) / elapsed;
          lastBytes = received;
          lastTime = now;
        }
        setDownloadProgress({
          filename: file.filename, status: "downloading", received, total,
          percent: total > 0 ? Math.min(100, (received / total) * 100) : null,
          speed, remaining: speed > 0 && total > received ? (total - received) / speed : null,
        });
      }

      await writable.close();
      writable = null;
      await deleteDownloadTask(taskId);
      setSavedTask(null);
      setDownloadProgress({ filename: file.filename, status: "completed", received, total: total || received, percent: 100, speed, remaining: 0 });
    } catch (error) {
      if (writable) {
        try { await writable.close(); } catch {}
        writable = null;
      }

      const action = downloadActionRef.current;
      if (action === "cancel") {
        try {
          const cleanup = await handle.createWritable({ keepExistingData: true });
          await cleanup.truncate(0);
          await cleanup.close();
        } catch {}
        await deleteDownloadTask(taskId);
        setSavedTask(null);
        setDownloadProgress({ filename: file.filename, status: "cancelled", received: 0, total: task.total });
      } else {
        task.received = received;
        task.updatedAt = Date.now();
        await saveDownloadTask(task);
        setSavedTask(task);
        if (action === "pause" || controller.signal.aborted) {
          setDownloadProgress({ filename: file.filename, status: "paused", received, total: task.total });
        } else {
          setDownloadProgress({ filename: file.filename, status: "failed", received, total: task.total, error: error.message || "Download interrupted. You can resume it." });
        }
      }
    } finally {
      if (downloadAbortRef.current === controller) downloadAbortRef.current = null;
      downloadActionRef.current = null;
    }
  }

  async function downloadFile(file) {
    if (downloadAbortRef.current) return;
    if (savedTask) {
      if (savedTask.fileUuid === file.uuid) {
        await resumeDownload();
      } else {
        setDownloadProgress({ filename: savedTask.filename, status: "paused", received: savedTask.received, total: savedTask.total, error: "Resume or discard the existing download before starting another file." });
      }
      return;
    }
    if (typeof window.showSaveFilePicker !== "function") {
      setDownloadProgress({ filename: file.filename, status: "unsupported", error: "Use the latest Chrome or Edge over HTTPS to enable resumable downloads." });
      return;
    }
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: file.filename });
    } catch (error) {
      if (error?.name !== "AbortError") setDownloadProgress({ filename: file.filename, status: "failed", error: error.message || "Could not choose a save location." });
      return;
    }
    await startDownload(file, handle, 0);
  }

  async function resumeDownload() {
    if (!savedTask || downloadAbortRef.current) return;
    let file = shareInfo?.files?.find((item) => item.uuid === savedTask.fileUuid);
    if (!file) {
      setDownloadProgress({ filename: savedTask.filename, status: "failed", error: "This file is no longer part of the share." });
      return;
    }
    // Trigger the permission request directly from the Resume button click.
    const permissionPromise = savedTask.handle.requestPermission({ mode: "readwrite" });
    if (shareInfo.hasPassword) {
      // Signed download URLs expire; obtain a fresh one before every resume.
      const response = await fetch("/s/" + uuid + "/verify-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        setDownloadProgress({ filename: file.filename, status: "paused", received: savedTask.received, total: savedTask.total, error: "Please unlock this share again to refresh its download link." });
        return;
      }
      const refreshed = await response.json();
      setShareInfo(refreshed);
      file = refreshed.files.find((item) => item.uuid === savedTask.fileUuid);
      if (!file) {
        setDownloadProgress({ filename: savedTask.filename, status: "failed", error: "This file is no longer part of the share." });
        return;
      }
    }
    await startDownload(file, savedTask.handle, savedTask.received, savedTask.id, permissionPromise);
  }

  function pauseDownload() {
    if (!downloadAbortRef.current) return;
    downloadActionRef.current = "pause";
    downloadAbortRef.current.abort();
  }

  function cancelDownload() {
    if (!downloadAbortRef.current) return;
    downloadActionRef.current = "cancel";
    downloadAbortRef.current.abort();
  }

  async function discardSavedDownload() {
    if (!savedTask) return;
    try {
      const writable = await savedTask.handle.createWritable({ keepExistingData: true });
      await writable.truncate(0);
      await writable.close();
    } catch {}
    await deleteDownloadTask(savedTask.id);
    setSavedTask(null);
    setDownloadProgress(null);
  }

  function formatRate(bytesPerSecond) {
    if (!bytesPerSecond) return "—";
    return `${humanSize(bytesPerSecond)}/s`;
  }

  function formatRemaining(seconds) {
    if (!Number.isFinite(seconds)) return "—";
    const value = Math.max(0, Math.ceil(seconds));
    if (value < 60) return `${value}s`;
    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }

  async function downloadZip() {
    if (zipping) return;
    setZipError("");
    setZipping(true);
    const headers = {
      "Content-Type": "application/json",
    };

    const url = password ? shareInfo.signedUrl : `/s/${uuid}/zip`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ uuids: Array.from(selected) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setZipError(err.error || "Failed to create ZIP.");
      setZipping(false);
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "selfdrop.zip";
    a.click();
    setZipping(false);
  }

  const selectedCount = selected.size;
  const totalFiles = shareInfo?.files?.length ?? 0;
  const selectedSize =
    shareInfo?.files
      ?.filter((f) => selected.has(f.uuid))
      .reduce((s, f) => s + f.size, 0) ?? 0;

  const zipDisabled = !shareInfo?.zipAvailable || selectedCount === 0;
  const overLimit = selectedSize > (shareInfo?.zipMaxBytes ?? Infinity);

  // ── Not found ─────────────────────────────────────────
  if (state === "notfound") {
    return (
      <div className="download-wrap">
        <div style={{ textAlign: "center" }}>
          <div className="not-found-code">404</div>
          <div className="not-found-msg">This page doesn't exist.</div>
          <div className="not-found-brand">
            <Logo />
          </div>
        </div>
      </div>
    );
  }

  // ── Loading ───────────────────────────────────────────
  if (state === "loading") {
    return (
      <div className="download-wrap">
        <div className="loading-wrap" style={{ height: "auto", padding: 60 }}>
          loading…
        </div>
      </div>
    );
  }

  // ── Password prompt ───────────────────────────────────
  if (state === "password") {
    return (
      <div className="download-wrap view-enter">
        <div
          className="download-card"
          style={{ maxWidth: 380, textAlign: "center" }}
        >
          <div style={{ padding: "36px 32px" }}>
            <div className="lock-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <rect
                  x="3"
                  y="11"
                  width="18"
                  height="11"
                  rx="2"
                  stroke="var(--text-2)"
                  strokeWidth="1.4"
                />
                <path
                  d="M7 11V7a5 5 0 0110 0v4"
                  stroke="var(--text-2)"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h2 className="auth-title" style={{ marginBottom: 6 }}>
              Password Required
            </h2>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-2)",
                marginBottom: 24,
                lineHeight: 1.6,
              }}
            >
              This share is protected. Enter the password to access it.
            </p>
            {pwError && <div className="alert alert-error">{pwError}</div>}
            <form onSubmit={handlePasswordSubmit}>
              <div className="form-group" style={{ textAlign: "left" }}>
                <label className="form-label">Password</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Enter password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setPwError("");
                  }}
                  autoFocus
                />
              </div>
              <button
                className="btn btn-primary btn-full"
                type="submit"
                disabled={pwLoading}
              >
                {pwLoading ? "Checking…" : "Unlock"}
              </button>
            </form>
            <p style={{ marginTop: 16, fontSize: 12, color: "var(--text-3)" }}>
              Contact the sender if you don't have the password.
            </p>
          </div>
          <div className="download-footer">
            <Logo />
          </div>
        </div>
      </div>
    );
  }

  // ── Ready ─────────────────────────────────────────────
  const files = shareInfo.files || [];

  return (
    <div className="download-wrap download-wrap--list view-enter">
      <div className="download-card download-card--list">
        {/* Header */}
        <div className="download-header download-header--list">
          <div className="download-branding">
            <Logo />
          </div>
          <div className="download-filename">{shareInfo.shareTitle}</div>
          <div className="download-meta">
            <div
              className="download-meta-item"
              style={{
                color: isExpiringSoon(shareInfo.expiresAt)
                  ? "var(--warning)"
                  : undefined,
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="8"
                  cy="8"
                  r="6"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M8 5v3.5l2 2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              {isExpiringSoon(shareInfo.expiresAt) ? "Expires in " : "Expires "}
              {formatExpiry(shareInfo.expiresAt)}
            </div>
            <div className="download-meta-item">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 4h12v9a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM5 4V2h6v2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              {shareInfo.totalSizeHuman}
            </div>
            <div className="download-meta-item">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 1v9M5 7l3 3 3-3M2 14h12"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {shareInfo.downloadLimit
                ? `${shareInfo.downloadLimit - shareInfo.downloadCount} downloads left`
                : "Unlimited downloads"}
            </div>
          </div>
        </div>

        {/* File list — Fix: paddingTop/Bottom for breathing room */}
        <ul style={{ listStyle: "none", padding: 4 }}>
          {files.map((file, i) => {
            const isSelected = selected.has(file.uuid);
            return (
              <li
                key={file.path}
                onClick={() => toggleSelect(file.uuid)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 28px",
                  borderBottom:
                    i < files.length - 1 ? "1px solid var(--border)" : "none",
                  cursor: "pointer",
                  transition: "background 0.1s",
                  userSelect: "none",
                  background: isSelected
                    ? "var(--accent-light)"
                    : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!isSelected)
                    e.currentTarget.style.background = "var(--surface2)";
                }}
                onMouseLeave={(e) => {
                  if (!isSelected)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                {/* Selection indicator */}
                <div
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    border: `1.5px solid ${isSelected ? "var(--accent)" : "var(--border-strong)"}`,
                    background: isSelected ? "var(--accent)" : "var(--surface)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "all 0.15s",
                  }}
                >
                  {isSelected && (
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                      <path
                        d="M2 5l2.5 2.5L8 2.5"
                        stroke="#fff"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </div>

                {/* File icon */}
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 6,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    background: isSelected
                      ? "var(--accent-light)"
                      : "var(--surface2)",
                    border: `1px solid ${isSelected ? "rgba(45,106,79,0.2)" : "var(--border)"}`,
                    transition: "all 0.15s",
                  }}
                >
                  <FileTypeIcon
                    mimeType={file.mimeType}
                    size={16}
                    color={isSelected ? "var(--accent)" : "var(--text-2)"}
                  />
                </div>

                {/* File info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 12,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {file.filename}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: "var(--text-3)",
                      marginTop: 2,
                    }}
                  >
                    {file.mimeType?.split("/")[1]?.toUpperCase() || "FILE"} ·{" "}
                    {file.sizeHuman}
                  </div>
                </div>

                {/* Actions */}
                <div
                  style={{ display: "flex", gap: 6, flexShrink: 0 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    className="icon-btn"
                    title="Preview"
                    onClick={() => setPreviewIndex(i)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                      <circle
                        cx="8"
                        cy="8"
                        r="2"
                        stroke="currentColor"
                        strokeWidth="1.3"
                      />
                    </svg>
                  </button>
                  <button
                    className="icon-btn"
                    title="Download this file"
                    onClick={() => downloadFile(file)}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M8 1v9M5 7l3 3 3-3M2 14h12"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>

        {/* Sticky footer */}
        <div className="dl-footer">
          <div className="dl-footer__info">
            <strong>
              {selectedCount} of {totalFiles}
            </strong>{" "}
            selected
            {selectedCount > 0 && (
              <span className="dl-footer__size">
                {" "}
                · {humanSize(selectedSize)}
              </span>
            )}
          </div>
          <div className="dl-footer__actions">
            {zipError && <div className="dl-footer__error">{zipError}</div>}
            {selectedCount < totalFiles ? (
              <button
                className="btn btn-ghost dl-footer__btn"
                onClick={selectAll}
              >
                Select all
              </button>
            ) : (
              <button
                className="btn btn-ghost dl-footer__btn"
                onClick={selectNone}
              >
                Deselect all
              </button>
            )}
            <button
              className="btn btn-secondary dl-footer__btn"
              title={
                overLimit
                  ? `Selection exceeds ${humanSize(shareInfo.zipMaxBytes)} ZIP limit`
                  : !shareInfo.zipAvailable
                    ? "Total share size exceeds ZIP limit"
                    : ""
              }
              style={{
                opacity: zipDisabled || overLimit ? 0.45 : 1,
                cursor: zipDisabled || overLimit ? "not-allowed" : "pointer",
              }}
              onClick={downloadZip}
              disabled={zipDisabled || overLimit || zipping}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 4h12v9a1 1 0 01-1 1H3a1 1 0 01-1-1V4zM5 4V2h6v2"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              <span className="dl-footer__zip-label">
                {zipping ? "Building ZIP…" : "Download as ZIP"}
              </span>
            </button>
          </div>
        </div>

        {/* Branding footer */}
        <div className="download-footer">
          <span>
            Shared securely via{" "}
            <a
              href="https://github.com/MiraiBytesLabs/selfdrop"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--accent)", textDecoration: "none" }}
              onMouseEnter={(e) =>
                (e.target.style.textDecoration = "underline")
              }
              onMouseLeave={(e) => (e.target.style.textDecoration = "none")}
            >
              SelfDrop
            </a>
          </span>
          <span>&middot;</span>
          <span>Self-hosted file sharing</span>
        </div>
      </div>

      {/* Preview modal */}
      {previewIndex !== null && (
        <PreviewModal
          files={files}
          initialIndex={previewIndex}
          uuid={uuid}
          hasPassword={password ? true : false}
          onClose={() => setPreviewIndex(null)}
        />
      )}
      {downloadProgress && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            right: 20,
            bottom: 20,
            zIndex: 1000,
            width: "min(480px, calc(100vw - 32px))",
            padding: 16,
            border: "1px solid var(--border)",
            borderRadius: 10,
            background: "var(--surface)",
            color: "var(--text)",
            boxShadow: "var(--shadow-md)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                {downloadProgress.status === "completed" ? "Download complete" :
                  downloadProgress.status === "cancelled" ? "Download cancelled" :
                  downloadProgress.status === "failed" ? "Download failed" :
                  downloadProgress.status === "unsupported" ? "Browser not supported" : downloadProgress.status === "paused" ? "Download paused" : "Downloading"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {downloadProgress.filename}
              </div>
            </div>
            {downloadProgress.status !== "downloading" && !savedTask && (
              <button className="icon-btn" title="Dismiss" onClick={() => setDownloadProgress(null)}>×</button>
            )}
          </div>

          {downloadProgress.status === "downloading" && (
            <>
              <div style={{ height: 6, background: "var(--surface2)", borderRadius: 99, overflow: "hidden", margin: "12px 0 8px" }}>
                <div style={{
                  width: downloadProgress.percent == null ? "35%" : `${downloadProgress.percent}%`,
                  height: "100%",
                  background: "var(--accent)",
                  borderRadius: 99,
                  transition: "width 0.2s ease",
                }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11, color: "var(--text-2)", fontFamily: "var(--mono)" }}>
                <span>{humanSize(downloadProgress.received)} / {downloadProgress.total ? humanSize(downloadProgress.total) : "—"}</span>
                <span>{downloadProgress.percent == null ? "…" : `${downloadProgress.percent.toFixed(1)}%`}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 5, fontSize: 11, color: "var(--text-3)" }}>
                <span>{formatRate(downloadProgress.speed)}</span>
                <span>{downloadProgress.remaining == null ? "Calculating…" : `Remaining ${formatRemaining(downloadProgress.remaining)}`}</span>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn btn-secondary" onClick={pauseDownload}>Pause</button>
                <button className="btn btn-danger-ghost" onClick={cancelDownload}>Cancel</button>
              </div>
            </>
          )}

          {(downloadProgress.status === "paused" || (downloadProgress.status === "failed" && savedTask)) && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-2)" }}>
              {humanSize(downloadProgress.received)} saved. You can resume after refreshing or reopening this page.
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn btn-primary" onClick={resumeDownload}>Resume download</button>
                <button className="btn btn-danger-ghost" onClick={discardSavedDownload}>Discard</button>
              </div>
              {downloadProgress.error && <div style={{ color: "var(--danger)", marginTop: 8 }}>{downloadProgress.error}</div>}
            </div>
          )}
          {downloadProgress.status === "completed" && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--accent)" }}>
              {humanSize(downloadProgress.received)} saved successfully.
            </div>
          )}
          {downloadProgress.status === "cancelled" && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-2)" }}>
              The partial file was discarded.
            </div>
          )}
          {((downloadProgress.status === "failed" && !savedTask) || downloadProgress.status === "unsupported") && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger)", lineHeight: 1.5 }}>
              {downloadProgress.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function humanSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
