import { useState, useEffect, useRef } from "react";
import Logo from "../components/Logo.jsx";
import FileTypeIcon from "../components/FileTypeIcon.jsx";
import PreviewModal from "../components/PreviewModal.jsx";
import { formatExpiry, isExpiringSoon } from "../utils/formatDate.js";
import { getUrl } from "../utils/downloadUtils.js";

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
  const downloadAbortRef = useRef(null);

  useEffect(() => {
    loadShareInfo();
  }, [uuid]);

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

  async function downloadFile(file) {
    if (downloadAbortRef.current) return;

    if (typeof window.showSaveFilePicker !== "function") {
      setDownloadProgress({
        filename: file.filename,
        status: "unsupported",
        error: "Your browser does not support save-with-progress. Please use the latest Chrome or Edge over HTTPS.",
      });
      return;
    }

    // Must be called directly from the click handler before the first await.
    let pickerPromise;
    try {
      pickerPromise = window.showSaveFilePicker({
        suggestedName: file.filename,
      });
    } catch (error) {
      setDownloadProgress({
        filename: file.filename,
        status: "failed",
        error: error.message || "Could not open the save dialog.",
      });
      return;
    }

    let handle;
    try {
      handle = await pickerPromise;
    } catch (error) {
      if (error?.name === "AbortError") return;
      setDownloadProgress({
        filename: file.filename,
        status: "failed",
        error: error.message || "Could not choose a save location.",
      });
      return;
    }

    const controller = new AbortController();
    downloadAbortRef.current = controller;
    let writable = null;
    let received = 0;
    let lastBytes = 0;
    let lastTime = performance.now();
    let speed = 0;

    setDownloadProgress({
      filename: file.filename,
      status: "downloading",
      received: 0,
      total: Number(file.size) || 0,
      percent: 0,
      speed: 0,
      remaining: null,
    });

    try {
      const url = getUrl(file, uuid, shareInfo.hasPassword);
      const response = await fetch(url, {
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok) {
        const message = await response.text().catch(() => "");
        throw new Error(message || `Download failed (HTTP ${response.status}).`);
      }
      if (!response.body) {
        throw new Error("This browser did not provide a readable download stream.");
      }

      const headerLength = Number(response.headers.get("Content-Length"));
      const total = headerLength > 0 ? headerLength : Number(file.size) || 0;
      writable = await handle.createWritable();
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        await writable.write(value);
        received += value.byteLength;

        const now = performance.now();
        const elapsed = (now - lastTime) / 1000;
        if (elapsed >= 0.4) {
          speed = (received - lastBytes) / elapsed;
          lastBytes = received;
          lastTime = now;
        }

        setDownloadProgress({
          filename: file.filename,
          status: "downloading",
          received,
          total,
          percent: total > 0 ? Math.min(100, (received / total) * 100) : null,
          speed,
          remaining: speed > 0 && total > received ? (total - received) / speed : null,
        });
      }

      await writable.close();
      writable = null;
      setDownloadProgress({
        filename: file.filename,
        status: "completed",
        received,
        total: total || received,
        percent: 100,
        speed,
        remaining: 0,
      });
    } catch (error) {
      if (writable) {
        try {
          await writable.abort();
        } catch {}
      }

      if (error?.name === "AbortError" || controller.signal.aborted) {
        setDownloadProgress({
          filename: file.filename,
          status: "cancelled",
          received,
          total: Number(file.size) || 0,
        });
      } else {
        setDownloadProgress({
          filename: file.filename,
          status: "failed",
          received,
          total: Number(file.size) || 0,
          error: error.message || "Download failed.",
        });
      }
    } finally {
      if (downloadAbortRef.current === controller) {
        downloadAbortRef.current = null;
      }
    }
  }

  function cancelDownload() {
    downloadAbortRef.current?.abort();
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
            width: "min(380px, calc(100vw - 32px))",
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
                  downloadProgress.status === "unsupported" ? "Browser not supported" : "Downloading"}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {downloadProgress.filename}
              </div>
            </div>
            {downloadProgress.status !== "downloading" && (
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
              <button className="btn btn-danger-ghost" style={{ marginTop: 12 }} onClick={cancelDownload}>Cancel download</button>
            </>
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
          {(downloadProgress.status === "failed" || downloadProgress.status === "unsupported") && (
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
