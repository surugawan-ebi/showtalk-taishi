function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function renderAdminPage(csrfToken: string): string {
  const escapedCsrfToken = escapeHtmlAttribute(csrfToken);

  return String.raw`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#17253d">
  <meta name="showtalk-csrf" content="${escapedCsrfToken}">
  <title>ShowTalk Taishi 運行卓</title>
  <style>
    :root {
      --washi: #f3f0e7;
      --paper: #fffdf7;
      --navy: #17253d;
      --indigo: #355b87;
      --cinnabar: #b5402d;
      --ink: #202a35;
      --muted: #647080;
      --line: #c9c4b8;
      --success: #3f6a58;
      --danger-soft: #f8e8e3;
      --shadow: 0 16px 44px rgba(23, 37, 61, 0.08);
      --display: "Yu Mincho", "Hiragino Mincho ProN", "Hiragino Mincho Pro", serif;
      --body: "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif;
      --utility: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    html {
      min-width: 320px;
      background: var(--navy);
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background: var(--washi);
      font-family: var(--body);
      font-size: 15px;
      line-height: 1.65;
      border-top: 4px solid var(--cinnabar);
    }

    button,
    input,
    select,
    textarea {
      font: inherit;
    }

    button {
      touch-action: manipulation;
    }

    [hidden] {
      display: none !important;
    }

    .skip-link {
      position: fixed;
      z-index: 100;
      top: 8px;
      left: 8px;
      padding: 10px 14px;
      color: #fff;
      background: var(--navy);
      border: 2px solid #fff;
      transform: translateY(-160%);
    }

    .skip-link:focus {
      transform: translateY(0);
    }

    :focus-visible {
      outline: 3px solid var(--cinnabar);
      outline-offset: 3px;
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    .masthead {
      color: #fff;
      background: var(--navy);
      border-bottom: 1px solid rgba(255, 255, 255, 0.16);
    }

    .masthead-inner {
      width: min(1440px, calc(100% - 40px));
      min-height: 76px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 24px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }

    .brand-seal {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 34px;
      height: 44px;
      color: #fff;
      background: var(--cinnabar);
      border: 1px solid rgba(255, 255, 255, 0.45);
      font-family: var(--display);
      font-size: 12px;
      letter-spacing: 0.08em;
      line-height: 1.15;
      writing-mode: vertical-rl;
    }

    .brand-title {
      display: block;
      font-family: var(--display);
      font-size: clamp(18px, 2vw, 24px);
      font-weight: 600;
      letter-spacing: 0.04em;
      line-height: 1.15;
    }

    .brand-subtitle {
      display: block;
      margin-top: 4px;
      color: rgba(255, 255, 255, 0.65);
      font-family: var(--utility);
      font-size: 10px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    .masthead-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
    }

    .connection-pill {
      display: inline-flex;
      align-items: center;
      min-height: 40px;
      gap: 8px;
      padding: 7px 12px;
      color: rgba(255, 255, 255, 0.82);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 999px;
      font-size: 12px;
      white-space: nowrap;
    }

    .connection-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #d5a45f;
      box-shadow: 0 0 0 3px rgba(213, 164, 95, 0.15);
    }

    .connection-pill[data-tone="ready"] .connection-dot {
      background: #8ab69e;
      box-shadow: 0 0 0 3px rgba(138, 182, 158, 0.15);
    }

    .connection-pill[data-tone="dirty"] .connection-dot,
    .connection-pill[data-tone="error"] .connection-dot {
      background: #df7967;
      box-shadow: 0 0 0 3px rgba(223, 121, 103, 0.16);
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 44px;
      padding: 9px 16px;
      color: var(--navy);
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 5px;
      font-weight: 700;
      line-height: 1.2;
      cursor: pointer;
      transition: transform 150ms ease, border-color 150ms ease, background-color 150ms ease;
    }

    .button:hover:not(:disabled) {
      border-color: var(--indigo);
      transform: translateY(-1px);
    }

    .button:disabled {
      cursor: not-allowed;
      opacity: 0.48;
    }

    .button-primary {
      color: #fff;
      background: var(--navy);
      border-color: var(--navy);
    }

    .button-primary:hover:not(:disabled) {
      background: #233a5d;
      border-color: #233a5d;
    }

    .button-danger {
      color: #fff;
      background: var(--cinnabar);
      border-color: var(--cinnabar);
    }

    .button-quiet-dark {
      color: #fff;
      background: transparent;
      border-color: rgba(255, 255, 255, 0.3);
    }

    .button-quiet-dark:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.56);
    }

    .button-compact {
      min-height: 34px;
      padding: 6px 10px;
      font-size: 11px;
    }

    .page {
      width: min(1440px, calc(100% - 40px));
      margin: 0 auto;
      padding: 42px 0 64px;
    }

    .intro {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 440px);
      align-items: end;
      gap: 44px;
      margin-bottom: 28px;
    }

    .eyebrow,
    .section-kicker {
      margin: 0 0 8px;
      color: var(--cinnabar);
      font-family: var(--utility);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
    }

    h1,
    h2,
    h3,
    p {
      overflow-wrap: anywhere;
    }

    h1 {
      margin: 0;
      color: var(--navy);
      font-family: var(--display);
      font-size: clamp(29px, 4vw, 50px);
      font-weight: 600;
      letter-spacing: 0.02em;
      line-height: 1.22;
    }

    .intro-copy {
      margin: 0 0 3px;
      color: var(--muted);
      font-size: 14px;
    }

    .local-note {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      color: var(--navy);
      font-family: var(--utility);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }

    .local-note::before {
      content: "";
      width: 18px;
      height: 1px;
      background: var(--cinnabar);
    }

    .auth-gate {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: center;
      gap: 20px;
      margin-bottom: 24px;
      padding: 18px 20px;
      color: var(--ink);
      background: #fff8e8;
      border: 1px solid #c9a85f;
      box-shadow: var(--shadow);
    }

    .auth-gate-seal {
      display: grid;
      place-items: center;
      width: 42px;
      height: 58px;
      color: #fff;
      background: var(--cinnabar);
      font-family: var(--display);
      font-size: 12px;
      letter-spacing: 0.08em;
      line-height: 1.1;
      writing-mode: vertical-rl;
    }

    .auth-gate h2 {
      margin: 0;
      color: var(--navy);
      font-family: var(--display);
      font-size: 19px;
    }

    .auth-gate p {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 12px;
    }

    .auth-gate-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
      flex-wrap: wrap;
    }

    .route-board {
      position: relative;
      display: grid;
      grid-template-columns: minmax(150px, 0.7fr) minmax(140px, 1.3fr) minmax(260px, 1.8fr);
      align-items: center;
      gap: 0;
      min-height: 96px;
      margin-bottom: 24px;
      padding: 18px 22px;
      color: #fff;
      background: var(--indigo);
      border: 1px solid rgba(23, 37, 61, 0.26);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .route-origin,
    .route-target-wrap {
      position: relative;
      z-index: 1;
      min-width: 0;
    }

    .route-origin {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .route-jack {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      background: var(--cinnabar);
      border: 4px solid #fff;
      border-radius: 50%;
      box-shadow: 0 0 0 1px rgba(23, 37, 61, 0.35);
    }

    .route-label {
      display: block;
      color: rgba(255, 255, 255, 0.65);
      font-family: var(--utility);
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    #routeSource {
      display: block;
      margin-top: 2px;
      font-family: var(--display);
      font-size: 18px;
      font-weight: 600;
    }

    .route-rail {
      position: relative;
      height: 44px;
      margin: 0 20px;
    }

    .route-rail::before,
    .route-rail::after {
      content: "";
      position: absolute;
      top: 50%;
      background: rgba(255, 255, 255, 0.8);
    }

    .route-rail::before {
      left: 0;
      right: 0;
      height: 1px;
    }

    .route-rail::after {
      right: 0;
      width: 1px;
      height: 31px;
      transform: translateY(-50%);
    }

    .route-rail span {
      position: absolute;
      top: 50%;
      width: 7px;
      height: 7px;
      background: var(--indigo);
      border: 1px solid #fff;
      border-radius: 50%;
      transform: translate(-50%, -50%);
    }

    .route-rail span:nth-child(1) { left: 24%; }
    .route-rail span:nth-child(2) { left: 50%; }
    .route-rail span:nth-child(3) { left: 76%; }

    .route-targets {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 30px;
      margin-top: 4px;
      flex-wrap: wrap;
    }

    .route-chip,
    .route-none {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 4px 9px;
      border: 1px solid rgba(255, 255, 255, 0.36);
      border-radius: 999px;
      font-family: var(--utility);
      font-size: 11px;
      line-height: 1.2;
    }

    .route-chip::before {
      content: "";
      width: 5px;
      height: 5px;
      margin-right: 7px;
      background: #fff;
      border-radius: 50%;
    }

    .route-none {
      color: rgba(255, 255, 255, 0.65);
      border-style: dashed;
    }

    .desk {
      display: grid;
      grid-template-columns: minmax(270px, 0.72fr) minmax(0, 2fr);
      align-items: start;
      gap: 22px;
    }

    .koe-panel,
    .editor-panel {
      background: var(--paper);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
    }

    .koe-panel {
      position: sticky;
      top: 20px;
      padding: 20px;
    }

    .panel-heading,
    .editor-heading {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      padding-bottom: 15px;
      border-bottom: 1px solid var(--line);
    }

    .panel-heading h2,
    .editor-heading h2 {
      margin: 0;
      color: var(--navy);
      font-family: var(--display);
      font-size: 21px;
      font-weight: 600;
      line-height: 1.3;
    }

    .panel-count,
    .editor-id {
      color: var(--muted);
      font-family: var(--utility);
      font-size: 11px;
    }

    .koe-list {
      display: grid;
      gap: 10px;
      margin-top: 15px;
    }

    .koe-card {
      position: relative;
      width: 100%;
      min-height: 112px;
      padding: 14px;
      color: var(--ink);
      text-align: left;
      background: #fffefa;
      border: 1px solid #d9d5cb;
      border-radius: 3px;
      cursor: pointer;
      transition: border-color 150ms ease, transform 150ms ease, box-shadow 150ms ease;
    }

    .koe-card:hover {
      border-color: var(--indigo);
      transform: translateX(2px);
    }

    .koe-card[aria-current="true"] {
      border-color: var(--cinnabar);
      box-shadow: inset 4px 0 0 var(--cinnabar);
    }

    .koe-card[aria-current="true"]::after {
      content: "";
      position: absolute;
      top: 25px;
      right: -21px;
      width: 20px;
      height: 1px;
      background: var(--cinnabar);
    }

    .card-top {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
    }

    .card-monogram {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      color: #fff;
      background: var(--navy);
      border-radius: 50%;
      font-family: var(--display);
      font-size: 15px;
    }

    .card-name {
      display: block;
      color: var(--navy);
      font-weight: 800;
      line-height: 1.3;
    }

    .card-id,
    .card-adapter {
      font-family: var(--utility);
      font-size: 10px;
    }

    .card-id {
      display: block;
      margin-top: 2px;
      color: var(--muted);
    }

    .card-adapter {
      max-width: 100px;
      padding: 3px 6px;
      color: var(--indigo);
      background: #edf1f6;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .card-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 12px 0 0 44px;
    }

    .card-meta-pair {
      min-width: 0;
    }

    .card-meta-label {
      display: block;
      color: var(--muted);
      font-family: var(--utility);
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .card-meta-value {
      display: block;
      margin-top: 1px;
      overflow: hidden;
      color: var(--ink);
      font-family: var(--utility);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .panel-empty {
      margin: 15px 0 0;
      padding: 22px 16px;
      color: var(--muted);
      text-align: center;
      border: 1px dashed var(--line);
    }

    .editor-panel {
      min-width: 0;
      padding: 24px clamp(18px, 3vw, 34px) 28px;
    }

    .editor-summary {
      min-width: 0;
    }

    .editor-summary p {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 13px;
    }

    .editor-form {
      margin-top: 22px;
    }

    fieldset {
      min-width: 0;
      margin: 0;
      padding: 0;
      border: 0;
    }

    fieldset + fieldset,
    fieldset + .consultation-section {
      margin-top: 30px;
      padding-top: 27px;
      border-top: 1px solid var(--line);
    }

    legend,
    .consultation-section h3 {
      width: 100%;
      margin: 0 0 16px;
      padding: 0;
      color: var(--navy);
      font-family: var(--display);
      font-size: 17px;
      font-weight: 700;
    }

    .field-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px 18px;
    }

    .field {
      min-width: 0;
    }

    .field-wide {
      grid-column: 1 / -1;
    }

    .field label {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 6px;
      color: var(--navy);
      font-size: 12px;
      font-weight: 800;
    }

    .optional {
      color: var(--muted);
      font-family: var(--utility);
      font-size: 9px;
      font-weight: 500;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    input,
    select,
    textarea {
      width: 100%;
      color: var(--ink);
      background: #fff;
      border: 1px solid #bdb8ad;
      border-radius: 3px;
    }

    input,
    select {
      min-height: 44px;
      padding: 9px 11px;
    }

    textarea {
      min-height: 104px;
      padding: 10px 11px;
      line-height: 1.55;
      resize: vertical;
    }

    input:hover,
    select:hover,
    textarea:hover {
      border-color: var(--indigo);
    }

    input:disabled,
    select:disabled,
    textarea:disabled {
      color: #8a8f97;
      background: #efeee9;
      cursor: not-allowed;
    }

    .field-help {
      margin: 5px 0 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
    }

    .model-console {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      grid-column: 1 / -1;
      padding: 12px 14px;
      background: #f0f3f7;
      border-left: 3px solid var(--indigo);
    }

    .model-console p {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.5;
    }

    .model-console strong {
      display: block;
      margin-bottom: 2px;
      color: var(--navy);
      font-family: var(--utility);
      font-size: 11px;
      letter-spacing: 0.04em;
    }

    .consultation-intro {
      margin: -8px 0 15px;
      color: var(--muted);
      font-size: 12px;
    }

    .consultation-list {
      display: grid;
      gap: 9px;
    }

    .consultation-row {
      display: grid;
      grid-template-columns: minmax(150px, 0.72fr) minmax(220px, 1.5fr);
      align-items: center;
      gap: 14px;
      padding: 12px 14px;
      background: #f8f6ef;
      border-left: 3px solid var(--line);
    }

    .consultation-row:has(input[type="checkbox"]:checked) {
      background: #f0f3f7;
      border-left-color: var(--indigo);
    }

    .consultation-check {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      align-items: center;
      gap: 9px;
      min-width: 0;
      color: var(--navy);
      font-weight: 800;
      cursor: pointer;
    }

    .consultation-check input {
      width: 19px;
      min-height: 19px;
      height: 19px;
      margin: 0;
      accent-color: var(--indigo);
    }

    .consultation-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .consultation-id {
      display: block;
      color: var(--muted);
      font-family: var(--utility);
      font-size: 10px;
      font-weight: 500;
    }

    .consultation-scope label {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
    }

    .consultation-scope textarea {
      min-height: 66px;
      font-size: 12px;
    }

    .consultation-empty {
      margin: 0;
      padding: 16px;
      color: var(--muted);
      border: 1px dashed var(--line);
    }

    .action-dock {
      position: sticky;
      z-index: 5;
      bottom: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 18px;
      margin: 30px -10px -14px;
      padding: 14px 10px;
      background: rgba(255, 253, 247, 0.96);
      border-top: 1px solid var(--line);
    }

    .save-note {
      margin: 0;
      color: var(--muted);
      font-size: 11px;
    }

    .editor-empty {
      padding: 68px 20px;
      color: var(--muted);
      text-align: center;
    }

    .page-footer {
      margin-top: 24px;
      color: var(--muted);
      font-size: 11px;
      text-align: right;
    }

    dialog {
      width: min(480px, calc(100% - 32px));
      padding: 0;
      color: var(--ink);
      background: var(--paper);
      border: 1px solid var(--navy);
      border-radius: 4px;
      box-shadow: 0 30px 90px rgba(10, 20, 34, 0.3);
    }

    dialog::backdrop {
      background: rgba(12, 22, 37, 0.72);
    }

    .dialog-body {
      padding: 26px;
    }

    .dialog-seal {
      display: inline-block;
      margin-bottom: 12px;
      padding: 3px 7px;
      color: #fff;
      background: var(--cinnabar);
      font-family: var(--utility);
      font-size: 10px;
      letter-spacing: 0.1em;
    }

    dialog h2 {
      margin: 0;
      color: var(--navy);
      font-family: var(--display);
      font-size: 24px;
    }

    dialog p {
      margin: 12px 0 0;
      color: var(--muted);
    }

    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 15px 26px;
      background: #eeece4;
      border-top: 1px solid var(--line);
    }

    .toast {
      position: fixed;
      z-index: 110;
      right: 20px;
      bottom: 20px;
      width: min(420px, calc(100% - 40px));
      padding: 13px 16px;
      color: #fff;
      background: var(--navy);
      border-left: 4px solid #8ab69e;
      box-shadow: 0 18px 52px rgba(10, 20, 34, 0.25);
      opacity: 0;
      pointer-events: none;
      transform: translateY(14px);
      transition: opacity 180ms ease, transform 180ms ease;
    }

    .toast[data-kind="error"] {
      border-left-color: #e57662;
    }

    .toast.is-visible {
      opacity: 1;
      transform: translateY(0);
    }

    @media (min-width: 901px) {
      .koe-panel {
        max-height: calc(100vh - 40px);
        max-height: calc(100dvh - 40px);
        overflow-y: auto;
        scrollbar-gutter: stable;
      }
    }

    @media (max-width: 900px) {
      .masthead-inner {
        align-items: flex-start;
        padding: 15px 0;
      }

      .masthead-actions {
        max-width: 420px;
      }

      .intro {
        grid-template-columns: 1fr;
        gap: 14px;
      }

      .auth-gate {
        grid-template-columns: auto minmax(0, 1fr);
      }

      .auth-gate-actions {
        grid-column: 1 / -1;
        justify-content: flex-start;
      }

      .route-board {
        grid-template-columns: minmax(130px, 0.8fr) minmax(80px, 0.6fr) minmax(190px, 1.4fr);
      }

      .desk {
        grid-template-columns: 1fr;
      }

      .koe-panel {
        position: static;
      }

      .koe-list {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .koe-card[aria-current="true"]::after {
        display: none;
      }
    }

    @media (max-width: 650px) {
      .masthead-inner,
      .page {
        width: min(100% - 24px, 1440px);
      }

      .masthead-inner {
        display: block;
      }

      .masthead-actions {
        justify-content: flex-start;
        margin-top: 14px;
      }

      .connection-pill {
        order: -1;
        width: 100%;
      }

      .page {
        padding-top: 28px;
      }

      .route-board {
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
        padding: 16px;
      }

      .auth-gate {
        grid-template-columns: minmax(0, 1fr);
      }

      .auth-gate-seal {
        width: auto;
        height: auto;
        justify-self: start;
        padding: 5px 9px;
        writing-mode: horizontal-tb;
      }

      .auth-gate-actions {
        grid-column: auto;
      }

      .route-rail {
        width: 1px;
        height: 34px;
        margin: 0 0 0 8px;
        background: rgba(255, 255, 255, 0.8);
      }

      .route-rail::before,
      .route-rail::after,
      .route-rail span {
        display: none;
      }

      .koe-panel,
      .editor-panel {
        padding: 16px;
      }

      .koe-list,
      .field-grid {
        grid-template-columns: 1fr;
      }

      .field-wide {
        grid-column: auto;
      }

      .consultation-row {
        grid-template-columns: 1fr;
      }

      .model-console {
        align-items: stretch;
        flex-direction: column;
        grid-column: auto;
      }

      .action-dock {
        align-items: stretch;
        flex-direction: column;
      }

      .action-dock .button {
        width: 100%;
      }

      .page-footer {
        text-align: left;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      html {
        scroll-behavior: auto;
      }

      *,
      *::before,
      *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
      }
    }
  </style>
</head>
<body>
  <a class="skip-link" href="#main-content">編集画面へ移動</a>

  <header class="masthead">
    <div class="masthead-inner">
      <div class="brand" aria-label="ShowTalk Taishi 運行卓">
        <span class="brand-seal" aria-hidden="true">運行</span>
        <span>
          <span class="brand-title">ShowTalk Taishi 運行卓</span>
          <span class="brand-subtitle">Local agent switchboard</span>
        </span>
      </div>
      <div class="masthead-actions">
        <div class="connection-pill" id="connectionPill" data-tone="loading" role="status" aria-live="polite">
          <span class="connection-dot" aria-hidden="true"></span>
          <span id="connectionState">設定を読み込み中</span>
        </div>
        <button class="button button-quiet-dark" id="reloadButton" type="button">再読込</button>
        <button class="button button-quiet-dark" id="restartButton" type="button">Gatewayを再起動</button>
      </div>
    </div>
  </header>

  <main class="page" id="main-content">
    <section class="intro" aria-labelledby="page-title">
      <div>
        <p class="eyebrow">Koe routing control</p>
        <h1 id="page-title">声の行き先を、<br>静かに整える。</h1>
      </div>
      <div>
        <p class="intro-copy">Slackに立つKoeの担当、会話範囲、相談経路を一か所で編集します。変更は保存するまでGatewayへ反映されません。</p>
        <span class="local-note">LOCALHOST ADMIN / 外部公開しないでください</span>
      </div>
    </section>

    <section class="auth-gate" id="authGate" aria-labelledby="authGateTitle" hidden>
      <span class="auth-gate-seal" aria-hidden="true">再接続</span>
      <div>
        <h2 id="authGateTitle">管理画面への接続を更新します</h2>
        <p id="authGateMessage">ページを再読み込みすると、ローカルの管理セッションを自動的に更新します。</p>
      </div>
      <div class="auth-gate-actions">
        <button class="button button-primary" id="reconnectButton" type="button">管理画面を再接続</button>
      </div>
    </section>

    <section class="route-board" aria-labelledby="route-heading">
      <h2 class="sr-only" id="route-heading">選択中Koeの相談経路</h2>
      <div class="route-origin">
        <span class="route-jack" aria-hidden="true"></span>
        <div>
          <span class="route-label">Selected Koe</span>
          <strong id="routeSource">読込中</strong>
        </div>
      </div>
      <div class="route-rail" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="route-target-wrap">
        <span class="route-label">Consultation route</span>
        <div class="route-targets" id="routeTargets"></div>
      </div>
      <p class="sr-only" id="routeSummary"></p>
    </section>

    <div class="desk">
      <aside class="koe-panel" aria-labelledby="koe-list-heading">
        <div class="panel-heading">
          <div>
            <p class="section-kicker">Line-up</p>
            <h2 id="koe-list-heading">配置されたKoe</h2>
          </div>
          <span class="panel-count" id="agentCount">—</span>
        </div>
        <div class="koe-list" id="koeList" aria-label="編集するKoeを選択"></div>
        <p class="panel-empty" id="koeEmpty" hidden>設定されたKoeがありません。設定ファイル側でKoeを追加してから再読込してください。</p>
      </aside>

      <section class="editor-panel" aria-labelledby="editor-title">
        <div class="editor-heading">
          <div class="editor-summary">
            <p class="section-kicker">Patch panel</p>
            <h2 id="editor-title">Koe設定</h2>
            <p id="editorDescription">左の一覧からKoeを選択してください。</p>
          </div>
          <span class="editor-id" id="editorBadge">NO SIGNAL</span>
        </div>

        <form class="editor-form" id="editorForm" autocomplete="off" hidden>
          <fieldset>
            <legend>基本識別</legend>
            <div class="field-grid">
              <div class="field">
                <label for="agentId">Koe ID</label>
                <input id="agentId" name="agentId" type="text" maxlength="120" required spellcheck="false" disabled>
                <p class="field-help">相談先の識別にも使う一意のIDです。初期版では変更できません。</p>
              </div>
              <div class="field">
                <label for="adapter">Adapter</label>
                <input id="adapter" name="adapter" type="text" required spellcheck="false" disabled>
              </div>
              <div class="field">
                <label for="adapterSessionId">Adapter session ID <span class="optional">任意</span></label>
                <input id="adapterSessionId" name="adapterSessionId" type="text" maxlength="256" spellcheck="false">
                <p class="field-help" id="adapter-session-help">チャンネル全体で使う既存Codexスレッド。Slackスレッド単位では自動作成されます。</p>
              </div>
              <div class="field field-wide">
                <label for="workspacePath">Workspace path</label>
                <input id="workspacePath" name="workspacePath" type="text" required spellcheck="false">
                <p class="field-help">変更すると旧WorkspaceのSlack返信位置を解除します。CodexスレッドIDを指定しなければ新しいスレッドを作ります。</p>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Codexの声質</legend>
            <div class="field-grid">
              <div class="model-console">
                <p><strong>NEXT TURN / HOT APPLY</strong><span id="modelCatalogStatus">Codex App Serverへ接続してモデル一覧を取得します。</span></p>
                <button class="button button-compact" id="refreshModelsButton" type="button">一覧を更新</button>
              </div>
              <div class="field">
                <label for="model">モデル <span class="optional">Koeごと</span></label>
                <select id="model" name="model" disabled>
                  <option value="">取得中…</option>
                </select>
                <p class="field-help">公開APIの全モデルではなく、このMacのCodex App Serverが選択可能として返したモデルです。</p>
              </div>
              <div class="field">
                <label for="reasoningEffort">思考強度 <span class="optional">モデル対応値</span></label>
                <select id="reasoningEffort" name="reasoningEffort" disabled>
                  <option value="">モデルの推奨値</option>
                </select>
                <p class="field-help">保存後、実行中の処理は変えず、次のターンから反映します。Gateway再起動は不要です。</p>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>承認</legend>
            <div class="field-grid">
              <div class="field field-wide">
                <p class="field-help">自動進行とWorkspace Git自動運転は停止しました。選択肢、Git操作、外部操作はmanualで確認します。</p>
              </div>
            </div>
            <div hidden aria-hidden="true">
            <div class="field-grid">
              <div class="field field-wide">
                <label>
                  <input id="automaticChoiceMode" name="automaticChoiceMode" type="checkbox">
                  通常の選択肢は一番上を自動で選ぶ
                </label>
                <p class="field-help">Koeが提示した通常の固定選択肢だけが対象です。Git承認、外部操作の最終確認、command/file承認は自動化せず、これまで通り人間へ確認します。選択結果はSlackに記録されます。</p>
              </div>
              <div class="field field-wide">
                <label for="autonomyProfileId">Workspace Git自動運転 profile <span class="optional">任意</span></label>
                <input id="autonomyProfileId" name="autonomyProfileId" type="text" spellcheck="false" pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}" placeholder="00000000-0000-4000-8000-000000000000">
                <p class="field-help">local-mcpのユーザー所有private stateに作成済みのprofile IDです。ここでの保存は候補選択だけで、権限を有効化しません。</p>
              </div>
              <div class="field">
                <label for="autonomyProfileRevision">Profile revision</label>
                <input id="autonomyProfileRevision" name="autonomyProfileRevision" type="number" min="1" step="1" value="1">
              </div>
              <div class="field">
                <label for="autonomyTtlMinutes">有効時間（分）</label>
                <input id="autonomyTtlMinutes" name="autonomyTtlMinutes" type="number" min="1" max="1440" step="1" value="60">
              </div>
              <div class="field field-wide">
                <label for="autonomyProfileLabel">表示ラベル <span class="optional">任意</span></label>
                <input id="autonomyProfileLabel" name="autonomyProfileLabel" type="text" maxlength="80" placeholder="development commit / push / Draft PR">
              </div>
              <div class="field field-wide">
                <p id="autonomyStatus" class="field-help" role="status">自動運転は未設定です。</p>
                <div class="masthead-actions">
                  <button class="button button-primary" id="enableAutonomyButton" type="button">SlackでONを確認</button>
                  <button class="button button-danger" id="disableAutonomyButton" type="button">SlackでOFFを確認</button>
                </div>
                <p class="field-help">ON/OFFはKoeのSlackチャンネルへ独立した確認カードを送り、承認者の構造化操作で確定します。既存のGit承認2択や承認待ちplanは変更しません。</p>
              </div>
            </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>Slackでの立ち位置</legend>
            <div class="field-grid">
              <div class="field">
                <label for="channelId">Channel ID</label>
                <input id="channelId" name="channelId" type="text" required spellcheck="false">
                <p class="field-help">変更すると古いSlack返信位置は解除されます。既存Codexスレッドを使う場合はsession IDも明示してください。</p>
              </div>
              <div class="field">
                <label for="conversationScope">会話の範囲</label>
                <select id="conversationScope" name="conversationScope" required>
                  <option value="channel">チャンネル全体</option>
                  <option value="slack_thread">Slackスレッド単位</option>
                </select>
              </div>
              <div class="field">
                <label for="callName">呼び名 <span class="optional">任意</span></label>
                <input id="callName" name="callName" type="text" maxlength="80">
              </div>
              <div class="field">
                <label for="displayName">表示名 <span class="optional">任意</span></label>
                <input id="displayName" name="displayName" type="text" maxlength="80">
              </div>
              <div class="field">
                <label for="iconUrl">アイコンURL <span class="optional">任意 / HTTPS</span></label>
                <input id="iconUrl" name="iconUrl" type="url" maxlength="2048" inputmode="url" placeholder="https://…" spellcheck="false">
              </div>
              <div class="field">
                <label for="iconEmoji">アイコン絵文字 <span class="optional">任意</span></label>
                <input id="iconEmoji" name="iconEmoji" type="text" maxlength="100" pattern=":[a-z0-9][a-z0-9_+.-]*:" title="Slackの :shortcode: 形式で入力してください" placeholder=":taishi:" spellcheck="false">
                <p class="field-help">アイコンURLとはどちらか一方だけ指定できます。</p>
              </div>
              <div class="field field-wide">
                <label for="persona">Slack persona <span class="optional">任意</span></label>
                <textarea id="persona" name="persona" maxlength="4000" rows="5" placeholder="Slack上での振る舞い、口調、責任範囲"></textarea>
              </div>
            </div>
          </fieldset>

          <fieldset>
            <legend>役割</legend>
            <div class="field-grid">
              <div class="field field-wide">
                <label for="role">Role</label>
                <textarea id="role" name="role" rows="5" required placeholder="このKoeが担当する仕事と責任範囲"></textarea>
              </div>
            </div>
          </fieldset>

          <section class="consultation-section" aria-labelledby="consultation-heading">
            <h3 id="consultation-heading">相談できるKoe</h3>
            <p class="consultation-intro">許可する相談先を選び、そのKoeへ持ち込める内容を具体的に記します。</p>
            <div class="consultation-list" id="consultationList"></div>
            <p class="consultation-empty" id="consultationEmpty" hidden>ほかに相談先として選べるKoeがありません。</p>
          </section>

          <div class="action-dock">
            <p class="save-note" id="saveNote">編集内容はまだありません。</p>
            <button class="button button-primary" id="saveButton" type="submit">この設定を保存</button>
          </div>
        </form>

        <div class="editor-empty" id="editorEmpty">
          <p>設定を読み込むと、ここにKoeの編集面が開きます。</p>
        </div>
      </section>
    </div>

    <footer class="page-footer">ShowTalk Taishi / localhost configuration desk</footer>
  </main>

  <dialog id="restartDialog" aria-labelledby="restartTitle" aria-describedby="restartDetail">
    <div class="dialog-body">
      <span class="dialog-seal">RESTART</span>
      <h2 id="restartTitle">Gatewayを再起動しますか？</h2>
      <p id="restartDetail">進行中の処理の完了を待ってから再起動します。保存済みの設定だけが再起動後に使われます。</p>
    </div>
    <div class="dialog-actions">
      <button class="button" id="cancelRestartButton" type="button">戻る</button>
      <button class="button button-danger" id="confirmRestartButton" type="button">再起動を依頼</button>
    </div>
  </dialog>

  <div class="toast" id="toast" role="status" aria-live="polite" aria-atomic="true"></div>

  <script nonce="${escapedCsrfToken}">
    (function () {
      "use strict";

      var csrfMeta = document.querySelector('meta[name="showtalk-csrf"]');
      var csrfToken = csrfMeta ? csrfMeta.content : "";
      if (window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      var state = {
        config: null,
        selectedIndex: 0,
        dirty: false,
        busy: false,
        toastTimer: 0,
        modelCatalogs: Object.create(null),
        modelRequests: Object.create(null),
        modelErrors: Object.create(null),
        autonomyStatuses: Object.create(null)
      };

      var elements = {
        connectionPill: document.getElementById("connectionPill"),
        connectionState: document.getElementById("connectionState"),
        reloadButton: document.getElementById("reloadButton"),
        restartButton: document.getElementById("restartButton"),
        authGate: document.getElementById("authGate"),
        authGateMessage: document.getElementById("authGateMessage"),
        reconnectButton: document.getElementById("reconnectButton"),
        routeSource: document.getElementById("routeSource"),
        routeTargets: document.getElementById("routeTargets"),
        routeSummary: document.getElementById("routeSummary"),
        agentCount: document.getElementById("agentCount"),
        koeList: document.getElementById("koeList"),
        koeEmpty: document.getElementById("koeEmpty"),
        editorTitle: document.getElementById("editor-title"),
        editorDescription: document.getElementById("editorDescription"),
        editorBadge: document.getElementById("editorBadge"),
        editorForm: document.getElementById("editorForm"),
        editorEmpty: document.getElementById("editorEmpty"),
        consultationList: document.getElementById("consultationList"),
        consultationEmpty: document.getElementById("consultationEmpty"),
        modelCatalogStatus: document.getElementById("modelCatalogStatus"),
        refreshModelsButton: document.getElementById("refreshModelsButton"),
        saveButton: document.getElementById("saveButton"),
        saveNote: document.getElementById("saveNote"),
        restartDialog: document.getElementById("restartDialog"),
        restartDetail: document.getElementById("restartDetail"),
        cancelRestartButton: document.getElementById("cancelRestartButton"),
        confirmRestartButton: document.getElementById("confirmRestartButton"),
        toast: document.getElementById("toast")
      };

      var fields = {
        id: document.getElementById("agentId"),
        adapter: document.getElementById("adapter"),
        adapterSessionId: document.getElementById("adapterSessionId"),
        model: document.getElementById("model"),
        reasoningEffort: document.getElementById("reasoningEffort"),
        automaticChoiceMode: document.getElementById("automaticChoiceMode"),
        autonomyProfileId: document.getElementById("autonomyProfileId"),
        autonomyProfileRevision: document.getElementById("autonomyProfileRevision"),
        autonomyTtlMinutes: document.getElementById("autonomyTtlMinutes"),
        autonomyProfileLabel: document.getElementById("autonomyProfileLabel"),
        workspacePath: document.getElementById("workspacePath"),
        channelId: document.getElementById("channelId"),
        conversationScope: document.getElementById("conversationScope"),
        callName: document.getElementById("callName"),
        persona: document.getElementById("persona"),
        displayName: document.getElementById("displayName"),
        iconUrl: document.getElementById("iconUrl"),
        iconEmoji: document.getElementById("iconEmoji"),
        role: document.getElementById("role")
      };
      elements.autonomyStatus = document.getElementById("autonomyStatus");
      elements.enableAutonomyButton = document.getElementById("enableAutonomyButton");
      elements.disableAutonomyButton = document.getElementById("disableAutonomyButton");

      function requireString(value, label) {
        if (typeof value !== "string") {
          throw new Error(label + " が文字列ではありません。");
        }
        return value;
      }

      function optionalString(value, label) {
        if (value === undefined || value === null) {
          return undefined;
        }
        return requireString(value, label);
      }

      function normalizeConsultations(value) {
        var normalized = Object.create(null);
        if (value === undefined || value === null) {
          return normalized;
        }
        if (typeof value !== "object" || Array.isArray(value)) {
          throw new Error("consultations の形式が正しくありません。");
        }
        Object.entries(value).forEach(function (entry) {
          var target = entry[0];
          var rule = entry[1];
          if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
            throw new Error("consultations." + target + " の形式が正しくありません。");
          }
          normalized[target] = { scope: requireString(rule.scope, "consultations." + target + ".scope") };
        });
        return normalized;
      }

      function normalizeAutonomyCandidate(value) {
        if (value === undefined || value === null) {
          return undefined;
        }
        if (typeof value !== "object" || Array.isArray(value)) {
          throw new Error("workspace_git_autonomy の形式が正しくありません。");
        }
        if (!Number.isSafeInteger(value.profile_revision) || value.profile_revision < 1 ||
            !Number.isSafeInteger(value.requested_ttl_minutes) || value.requested_ttl_minutes < 1 || value.requested_ttl_minutes > 1440) {
          throw new Error("workspace_git_autonomy のrevisionまたは期限が正しくありません。");
        }
        return {
          profile_id: requireString(value.profile_id, "workspace_git_autonomy.profile_id"),
          profile_revision: value.profile_revision,
          requested_ttl_minutes: value.requested_ttl_minutes,
          label: optionalString(value.label, "workspace_git_autonomy.label")
        };
      }

      function normalizeAgent(raw, index) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("agents[" + index + "] の形式が正しくありません。");
        }
        var slack = raw.slack;
        if (!slack || typeof slack !== "object" || Array.isArray(slack)) {
          throw new Error("agents[" + index + "].slack の形式が正しくありません。");
        }
        var conversationScope = requireString(slack.conversation_scope, "conversation_scope");
        if (conversationScope !== "channel" && conversationScope !== "slack_thread") {
          throw new Error("conversation_scope に未対応の値があります。");
        }
        return {
          id: requireString(raw.id, "id"),
          adapter: requireString(raw.adapter, "adapter"),
          adapter_session_id: optionalString(raw.adapter_session_id, "adapter_session_id"),
          adapter_model: optionalString(raw.adapter_model, "adapter_model"),
          adapter_reasoning_effort: optionalString(raw.adapter_reasoning_effort, "adapter_reasoning_effort"),
          model: optionalString(raw.model, "model"),
          reasoning_effort: optionalString(raw.reasoning_effort, "reasoning_effort"),
          automatic_choice_mode: raw.automatic_choice_mode === "ordinary_top_choice"
            ? "ordinary_top_choice"
            : raw.automatic_choice_mode === "off"
              ? "off"
              : (function () { throw new Error("automatic_choice_mode に未対応の値があります。"); })(),
          workspace_git_autonomy: normalizeAutonomyCandidate(raw.workspace_git_autonomy),
          workspace_path: requireString(raw.workspace_path, "workspace_path"),
          slack: {
            channel_id: requireString(slack.channel_id, "slack.channel_id"),
            conversation_scope: conversationScope,
            call_name: optionalString(slack.call_name, "slack.call_name"),
            persona: optionalString(slack.persona, "slack.persona"),
            display_name: optionalString(slack.display_name, "slack.display_name"),
            icon_url: optionalString(slack.icon_url, "slack.icon_url"),
            icon_emoji: optionalString(slack.icon_emoji, "slack.icon_emoji")
          },
          role: requireString(raw.role, "role"),
          consultations: normalizeConsultations(raw.consultations)
        };
      }

      function normalizeConfig(raw) {
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.agents)) {
          throw new Error("設定レスポンスに agents 配列がありません。");
        }
        if (!Array.isArray(raw.available_adapters)) {
          throw new Error("設定レスポンスに available_adapters 配列がありません。");
        }
        return {
          revision: requireString(raw.revision, "revision"),
          available_adapters: raw.available_adapters.map(function (adapter, index) {
            return requireString(adapter, "available_adapters[" + index + "]");
          }),
          agents: raw.agents.map(normalizeAgent)
        };
      }

      function normalizeModelCatalog(raw, expectedAgentId) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new Error("モデル一覧の形式が正しくありません。");
        }
        if (requireString(raw.agent_id, "agent_id") !== expectedAgentId) {
          throw new Error("別のKoeのモデル一覧が返されました。");
        }
        if (!Array.isArray(raw.models)) {
          throw new Error("モデル一覧にmodels配列がありません。");
        }
        return {
          agent_id: expectedAgentId,
          fetched_at: requireString(raw.fetched_at, "fetched_at"),
          models: raw.models.map(function (model, index) {
            if (!model || typeof model !== "object" || Array.isArray(model)) {
              throw new Error("models[" + index + "] の形式が正しくありません。");
            }
            if (!Array.isArray(model.supported_reasoning_efforts)) {
              throw new Error("models[" + index + "] に思考強度一覧がありません。");
            }
            return {
              id: requireString(model.id, "models[" + index + "].id"),
              model: requireString(model.model, "models[" + index + "].model"),
              display_name: requireString(model.display_name, "models[" + index + "].display_name"),
              description: requireString(model.description, "models[" + index + "].description"),
              is_default: model.is_default === true,
              default_reasoning_effort: requireString(model.default_reasoning_effort, "models[" + index + "].default_reasoning_effort"),
              supported_reasoning_efforts: model.supported_reasoning_efforts.map(function (effort, effortIndex) {
                if (!effort || typeof effort !== "object" || Array.isArray(effort)) {
                  throw new Error("思考強度の形式が正しくありません。");
                }
                return {
                  value: requireString(effort.value, "reasoning[" + effortIndex + "].value"),
                  description: requireString(effort.description, "reasoning[" + effortIndex + "].description")
                };
              }),
              input_modalities: Array.isArray(model.input_modalities)
                ? model.input_modalities.map(function (modality) { return requireString(modality, "input modality"); })
                : []
            };
          })
        };
      }

      function selectedAgent() {
        if (!state.config) {
          return null;
        }
        return state.config.agents[state.selectedIndex] || null;
      }

      function displayName(agent) {
        return agent.slack.display_name || agent.slack.call_name || agent.id;
      }

      function setConnection(tone, text) {
        elements.connectionPill.dataset.tone = tone;
        elements.connectionState.textContent = text;
      }

      function syncActionState() {
        var hasConfig = Boolean(state.config);
        elements.reloadButton.disabled = state.busy;
        elements.restartButton.disabled = state.busy;
        elements.saveButton.disabled = state.busy || !hasConfig || !selectedAgent();
        elements.refreshModelsButton.disabled = state.busy || !selectedAgent() || Boolean(selectedAgent() && state.modelRequests[selectedAgent().id]);
        elements.reconnectButton.disabled = state.busy;
        elements.confirmRestartButton.disabled = state.busy;
        var agent = selectedAgent();
        var status = agent ? state.autonomyStatuses[agent.id] : undefined;
        var hasCandidate = Boolean(agent && agent.workspace_git_autonomy);
        elements.enableAutonomyButton.disabled = state.busy || state.dirty || !hasCandidate || Boolean(status && status.state === "enabled");
        elements.disableAutonomyButton.disabled = state.busy || state.dirty || !status || (status.state !== "enabled" && status.state !== "expired");
      }

      function showAuthGate(message) {
        elements.authGate.hidden = false;
        elements.authGateMessage.textContent = message;
        setConnection("error", "管理接続の更新が必要です");
        syncActionState();
      }

      function hideAuthGate() {
        elements.authGate.hidden = true;
      }

      function authenticationError(message) {
        var error = new Error(message);
        error.name = "AdminAuthenticationError";
        return error;
      }

      function isAuthenticationError(error) {
        return error instanceof Error && error.name === "AdminAuthenticationError";
      }

      function setBusy(busy) {
        state.busy = busy;
        elements.editorForm.setAttribute("aria-busy", busy ? "true" : "false");
        syncActionState();
      }

      function showToast(message, kind) {
        window.clearTimeout(state.toastTimer);
        elements.toast.textContent = message;
        elements.toast.dataset.kind = kind || "success";
        elements.toast.setAttribute("role", kind === "error" ? "alert" : "status");
        elements.toast.classList.add("is-visible");
        state.toastTimer = window.setTimeout(function () {
          elements.toast.classList.remove("is-visible");
        }, 4200);
      }

      async function responseError(response) {
        var fallback = "HTTP " + response.status;
        var raw = "";
        try {
          raw = await response.text();
        } catch (_error) {
          return fallback;
        }
        if (!raw) {
          return fallback;
        }
        try {
          var parsed = JSON.parse(raw);
          var message = parsed && (parsed.error || parsed.message);
          if (typeof message === "string") {
            return message.slice(0, 300);
          }
        } catch (_error) {
          // Plain text responses are handled below.
        }
        return raw.replace(/\s+/g, " ").slice(0, 300);
      }

      async function requireSuccessfulResponse(response) {
        if (response.ok) {
          return;
        }
        var message = await responseError(response);
        if (response.status === 401) {
          throw authenticationError(message + " 「管理画面を再接続」を押してください。");
        }
        throw new Error(message);
      }

      function apiHeaders(extra) {
        return Object.assign({
          "accept": "application/json"
        }, extra || {});
      }

      function clearNode(node) {
        while (node.firstChild) {
          node.removeChild(node.firstChild);
        }
      }

      function makeTextElement(tagName, className, text) {
        var node = document.createElement(tagName);
        if (className) {
          node.className = className;
        }
        node.textContent = text;
        return node;
      }

      function renderKoeList() {
        clearNode(elements.koeList);
        var agents = state.config ? state.config.agents : [];
        elements.agentCount.textContent = agents.length + " KOE";
        elements.koeEmpty.hidden = agents.length !== 0;

        agents.forEach(function (agent, index) {
          var card = document.createElement("button");
          card.type = "button";
          card.className = "koe-card";
          card.setAttribute("aria-current", index === state.selectedIndex ? "true" : "false");
          card.setAttribute("aria-label", displayName(agent) + "を編集");

          var top = document.createElement("span");
          top.className = "card-top";
          var monogram = makeTextElement("span", "card-monogram", Array.from(displayName(agent))[0] || "声");
          monogram.setAttribute("aria-hidden", "true");
          var identity = document.createElement("span");
          identity.appendChild(makeTextElement("span", "card-name", displayName(agent)));
          identity.appendChild(makeTextElement("span", "card-id", agent.id));
          var adapter = makeTextElement("span", "card-adapter", agent.adapter);
          adapter.title = agent.adapter;
          top.appendChild(monogram);
          top.appendChild(identity);
          top.appendChild(adapter);

          var meta = document.createElement("span");
          meta.className = "card-meta";
          var channelPair = document.createElement("span");
          channelPair.className = "card-meta-pair";
          channelPair.appendChild(makeTextElement("span", "card-meta-label", "Slack"));
          channelPair.appendChild(makeTextElement("span", "card-meta-value", agent.slack.channel_id));
          var routesPair = document.createElement("span");
          routesPair.className = "card-meta-pair";
          routesPair.appendChild(makeTextElement("span", "card-meta-label", "Routes"));
          routesPair.appendChild(makeTextElement("span", "card-meta-value", String(Object.keys(agent.consultations).length)));
          meta.appendChild(channelPair);
          meta.appendChild(routesPair);

          card.appendChild(top);
          card.appendChild(meta);
          card.addEventListener("click", function () {
            selectAgent(index);
          });
          elements.koeList.appendChild(card);
        });
      }

      function renderRoutes() {
        clearNode(elements.routeTargets);
        var agent = selectedAgent();
        if (!agent) {
          elements.routeSource.textContent = "信号なし";
          elements.routeTargets.appendChild(makeTextElement("span", "route-none", "相談経路なし"));
          elements.routeSummary.textContent = "選択中のKoeはありません。";
          return;
        }

        elements.routeSource.textContent = displayName(agent);
        var targets = Object.keys(agent.consultations);
        if (targets.length === 0) {
          elements.routeTargets.appendChild(makeTextElement("span", "route-none", "相談先なし"));
          elements.routeSummary.textContent = displayName(agent) + "に許可された相談先はありません。";
          return;
        }

        targets.forEach(function (targetId) {
          var targetAgent = state.config.agents.find(function (candidate) {
            return candidate.id === targetId;
          });
          var chip = makeTextElement("span", "route-chip", targetAgent ? displayName(targetAgent) : targetId);
          chip.title = agent.consultations[targetId].scope;
          elements.routeTargets.appendChild(chip);
        });
        elements.routeSummary.textContent = displayName(agent) + "から相談できるKoe: " + targets.join("、");
      }

      function setFieldValue(field, value) {
        field.value = typeof value === "string" ? value : "";
      }

      function appendSelectOption(select, value, label, title) {
        var option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        if (title) {
          option.title = title;
        }
        select.appendChild(option);
        return option;
      }

      function selectedCatalogModel() {
        var agent = selectedAgent();
        var catalog = agent ? state.modelCatalogs[agent.id] : null;
        if (!catalog) {
          return null;
        }
        var selectedModel = fields.model.value || agent.adapter_model;
        if (selectedModel) {
          return catalog.models.find(function (model) {
            return model.model === selectedModel;
          }) || null;
        }
        return catalog.models.find(function (model) { return model.is_default; }) || catalog.models[0] || null;
      }

      function syncReasoningEffortOptions(preferredValue) {
        var agent = selectedAgent();
        var currentValue = typeof preferredValue === "string"
          ? preferredValue
          : fields.reasoningEffort.value;
        var model = selectedCatalogModel();
        clearNode(fields.reasoningEffort);
        var inheritedEffort = agent ? agent.adapter_reasoning_effort : undefined;
        var defaultLabel = inheritedEffort
          ? "Adapter設定を継承（" + inheritedEffort + "）"
          : model
            ? "モデルの推奨値（" + model.default_reasoning_effort + "）"
            : "モデルの推奨値";
        appendSelectOption(fields.reasoningEffort, "", defaultLabel);
        if (model) {
          model.supported_reasoning_efforts.forEach(function (effort) {
            appendSelectOption(
              fields.reasoningEffort,
              effort.value,
              effort.value,
              effort.description
            );
          });
        }
        if (
          currentValue &&
          !Array.from(fields.reasoningEffort.options).some(function (option) {
            return option.value === currentValue;
          })
        ) {
          appendSelectOption(
            fields.reasoningEffort,
            currentValue,
            currentValue + "（現在の設定 / 一覧外）",
            "Codex App Serverの現在の候補にはありません。"
          );
        }
        fields.reasoningEffort.value = currentValue || "";
        fields.reasoningEffort.disabled = !model && !currentValue;
      }

      function renderModelSelection(agent) {
        var catalog = state.modelCatalogs[agent.id];
        var loading = Boolean(state.modelRequests[agent.id]);
        clearNode(fields.model);
        appendSelectOption(
          fields.model,
          "",
          agent.adapter_model
            ? "Adapter設定を継承（" + agent.adapter_model + "）"
            : "Codexのデフォルト"
        );
        if (catalog) {
          catalog.models.forEach(function (model) {
            appendSelectOption(
              fields.model,
              model.model,
              model.display_name + (model.is_default ? "（Codex既定）" : ""),
              model.description
            );
          });
        }
        if (
          agent.model &&
          !Array.from(fields.model.options).some(function (option) {
            return option.value === agent.model;
          })
        ) {
          appendSelectOption(
            fields.model,
            agent.model,
            agent.model + "（現在の設定 / 一覧外）",
            "Codex App Serverの現在の候補にはありません。"
          );
        }
        fields.model.value = agent.model || "";
        fields.model.disabled = loading;
        if (loading) {
          elements.modelCatalogStatus.textContent = "Codex App Serverからモデル一覧を取得中です…";
        } else if (catalog) {
          elements.modelCatalogStatus.textContent = catalog.models.length + "件のモデルを取得済み。保存後は次のターンから反映します。";
        } else if (state.modelErrors[agent.id]) {
          elements.modelCatalogStatus.textContent = "取得できませんでした: " + state.modelErrors[agent.id];
        } else {
          elements.modelCatalogStatus.textContent = "モデル一覧をまだ取得していません。";
        }
        syncReasoningEffortOptions(agent.reasoning_effort);
        syncActionState();
      }

      async function loadModelCatalog(agentId, refresh) {
        if (state.modelRequests[agentId]) {
          return;
        }
        state.modelRequests[agentId] = true;
        var agent = selectedAgent();
        if (agent && agent.id === agentId) {
          renderModelSelection(agent);
        }
        try {
          var suffix = refresh ? "/refresh" : "";
          var response = await fetch(
            "/api/agents/" + encodeURIComponent(agentId) + "/models" + suffix,
            {
              method: refresh ? "POST" : "GET",
              credentials: "same-origin",
              cache: "no-store",
              headers: apiHeaders(refresh ? { "x-showtalk-csrf": csrfToken } : undefined)
            }
          );
          await requireSuccessfulResponse(response);
          state.modelCatalogs[agentId] = normalizeModelCatalog(await response.json(), agentId);
          delete state.modelErrors[agentId];
          if (refresh) {
            showToast("Codexのモデル一覧を更新しました。", "success");
          }
        } catch (error) {
          if (isAuthenticationError(error)) {
            showAuthGate(error.message);
          }
          state.modelErrors[agentId] = error instanceof Error ? error.message : String(error);
          showToast("モデル一覧を取得できませんでした: " + (error instanceof Error ? error.message : String(error)), "error");
        } finally {
          delete state.modelRequests[agentId];
          var selected = selectedAgent();
          if (selected && selected.id === agentId) {
            renderModelSelection(selected);
          } else {
            syncActionState();
          }
        }
      }

      function isEnvironmentReference(value) {
        return typeof value === "string" && /\$\{[A-Z_][A-Z0-9_]*\}/.test(value);
      }

      function hasOwn(object, key) {
        return Object.prototype.hasOwnProperty.call(object, key);
      }

      function renderConsultations(agent) {
        clearNode(elements.consultationList);
        var knownTargets = state.config.agents
          .filter(function (candidate) { return candidate.id !== agent.id; })
          .map(function (candidate) { return candidate.id; });
        var configuredTargets = Object.keys(agent.consultations).filter(function (targetId) {
          return targetId !== agent.id;
        });
        var targetIds = Array.from(new Set(knownTargets.concat(configuredTargets)));
        elements.consultationEmpty.hidden = targetIds.length !== 0;

        targetIds.forEach(function (targetId, index) {
          var targetAgent = state.config.agents.find(function (candidate) {
            return candidate.id === targetId;
          });
          var enabled = hasOwn(agent.consultations, targetId);
          var row = document.createElement("div");
          row.className = "consultation-row";
          row.dataset.targetId = targetId;

          var checkLabel = document.createElement("label");
          checkLabel.className = "consultation-check";
          var checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = enabled;
          checkbox.setAttribute("aria-describedby", "consultation-scope-label-" + index);
          var checkText = document.createElement("span");
          checkText.appendChild(makeTextElement("span", "consultation-name", targetAgent ? displayName(targetAgent) : "不明なKoe"));
          checkText.appendChild(makeTextElement("span", "consultation-id", targetId));
          checkLabel.appendChild(checkbox);
          checkLabel.appendChild(checkText);

          var scopeWrap = document.createElement("div");
          scopeWrap.className = "consultation-scope";
          var scopeLabel = makeTextElement("label", "", "相談できる範囲");
          scopeLabel.id = "consultation-scope-label-" + index;
          var scope = document.createElement("textarea");
          scope.rows = 2;
          scope.maxLength = 2000;
          scope.value = enabled ? agent.consultations[targetId].scope : "";
          scope.placeholder = "例: 仕様・実装の敵対的レビューに限る";
          scope.disabled = !enabled;
          scope.required = enabled;
          scope.setAttribute("aria-labelledby", scopeLabel.id);
          scopeWrap.appendChild(scopeLabel);
          scopeWrap.appendChild(scope);

          checkbox.addEventListener("change", function () {
            scope.disabled = !checkbox.checked;
            scope.required = checkbox.checked;
            if (checkbox.checked) {
              scope.focus();
            }
          });

          row.appendChild(checkLabel);
          row.appendChild(scopeWrap);
          elements.consultationList.appendChild(row);
        });
      }

      function renderAutonomy(agent) {
        var candidate = agent.workspace_git_autonomy;
        setFieldValue(fields.autonomyProfileId, candidate && candidate.profile_id);
        setFieldValue(fields.autonomyProfileRevision, candidate ? String(candidate.profile_revision) : "1");
        setFieldValue(fields.autonomyTtlMinutes, candidate ? String(candidate.requested_ttl_minutes) : "60");
        setFieldValue(fields.autonomyProfileLabel, candidate && candidate.label);
        var status = state.autonomyStatuses[agent.id];
        if (status && status.state === "enabled") {
          elements.autonomyStatus.textContent = "自動運転はONです（期限: " + new Date(status.expiresAt).toLocaleString() + "）。" + (!candidate ? " Profile候補は削除済みのため、OFFのみ実行できます。" : "");
        } else if (status && status.state === "expired") {
          elements.autonomyStatus.textContent = "前回のactivationは期限切れです。新しいSlack確認が必要です。";
        } else if (!candidate) {
          elements.autonomyStatus.textContent = "Profile候補は未設定です。既定はmanualです。";
        } else if (!status || status.state === "disabled" || status.state === "unconfigured") {
          elements.autonomyStatus.textContent = "自動運転はOFFです。保存後、Slack確認カードからONにできます。";
        } else {
          elements.autonomyStatus.textContent = "自動運転状態を確認できません。";
        }
        var enabled = status && status.state === "enabled";
        elements.enableAutonomyButton.disabled = state.busy || state.dirty || !candidate || enabled;
        elements.disableAutonomyButton.disabled = state.busy || state.dirty || !status || (status.state !== "enabled" && status.state !== "expired");
      }

      function renderEditor() {
        var agent = selectedAgent();
        var hasAgent = Boolean(agent);
        elements.editorForm.hidden = !hasAgent;
        elements.editorEmpty.hidden = hasAgent;

        if (!agent) {
          elements.editorTitle.textContent = "Koe設定";
          elements.editorDescription.textContent = "左の一覧からKoeを選択してください。";
          elements.editorBadge.textContent = "NO SIGNAL";
          elements.modelCatalogStatus.textContent = "Koeを選択するとモデル一覧を取得します。";
          fields.model.disabled = true;
          fields.reasoningEffort.disabled = true;
          elements.enableAutonomyButton.disabled = true;
          elements.disableAutonomyButton.disabled = true;
          clearNode(elements.consultationList);
          syncActionState();
          return;
        }

        elements.editorTitle.textContent = displayName(agent) + " の設定";
        elements.editorDescription.textContent = "担当範囲とSlackでの振る舞い、相談経路を編集します。";
        elements.editorBadge.textContent = agent.id;
        setFieldValue(fields.id, agent.id);
        setFieldValue(fields.adapter, agent.adapter);
        setFieldValue(fields.adapterSessionId, agent.adapter_session_id);
        renderModelSelection(agent);
        setFieldValue(fields.workspacePath, agent.workspace_path);
        setFieldValue(fields.channelId, agent.slack.channel_id);
        setFieldValue(fields.conversationScope, agent.slack.conversation_scope);
        setFieldValue(fields.callName, agent.slack.call_name);
        setFieldValue(fields.persona, agent.slack.persona);
        setFieldValue(fields.displayName, agent.slack.display_name);
        setFieldValue(fields.iconUrl, agent.slack.icon_url);
        setFieldValue(fields.iconEmoji, agent.slack.icon_emoji);
        fields.iconUrl.type = isEnvironmentReference(agent.slack.icon_url) ? "text" : "url";
        if (isEnvironmentReference(agent.slack.icon_emoji)) {
          fields.iconEmoji.removeAttribute("pattern");
        } else {
          fields.iconEmoji.setAttribute("pattern", ":[a-z0-9][a-z0-9_+.-]*:");
        }
        setFieldValue(fields.role, agent.role);
        fields.automaticChoiceMode.checked = agent.automatic_choice_mode === "ordinary_top_choice";
        renderAutonomy(agent);
        syncAdapterSessionField();
        renderConsultations(agent);
        syncActionState();
        if (!state.modelCatalogs[agent.id] && !state.modelRequests[agent.id]) {
          void loadModelCatalog(agent.id, false);
        }
      }

      function renderAll() {
        renderKoeList();
        renderRoutes();
        renderEditor();
      }

      function markDirty() {
        if (!state.config || state.busy || !selectedAgent()) {
          return;
        }
        state.dirty = true;
        elements.saveNote.textContent = "未保存の変更があります。";
        setConnection("dirty", "未保存の変更あり");
        syncActionState();
      }

      function selectAgent(index) {
        if (!state.config || index === state.selectedIndex) {
          return;
        }
        if (state.dirty && !window.confirm("未保存の変更を破棄して、別のKoeを開きますか？")) {
          return;
        }
        state.selectedIndex = index;
        state.dirty = false;
        elements.saveNote.textContent = "編集内容はまだありません。";
        setConnection("ready", "設定を読込済み");
        renderAll();
      }

      function optionalTrimmed(field) {
        var value = field.value.trim();
        return value ? value : undefined;
      }

      function optionalPersona(field) {
        return field.value.trim() ? field.value : undefined;
      }

      function syncAdapterSessionField() {
        var threadScoped = fields.conversationScope.value === "slack_thread";
        fields.adapterSessionId.disabled = threadScoped;
        fields.adapterSessionId.setAttribute("aria-describedby", "adapter-session-help");
      }

      function collectAgentFromForm() {
        fields.id.setCustomValidity("");
        fields.adapter.setCustomValidity("");
        fields.model.setCustomValidity("");
        fields.reasoningEffort.setCustomValidity("");
        fields.workspacePath.setCustomValidity("");
        fields.channelId.setCustomValidity("");
        fields.iconUrl.setCustomValidity("");
        fields.iconEmoji.setCustomValidity("");
        fields.role.setCustomValidity("");

        [
          [fields.id, "Koe ID"],
          [fields.adapter, "Adapter"],
          [fields.workspacePath, "Workspace path"],
          [fields.channelId, "Channel ID"],
          [fields.role, "Role"]
        ].forEach(function (item) {
          if (!item[0].value.trim()) {
            item[0].setCustomValidity(item[1] + "を入力してください。");
          }
        });

        var nextId = fields.id.value.trim();
        var duplicate = state.config.agents.some(function (agent, index) {
          return index !== state.selectedIndex && agent.id === nextId;
        });
        if (duplicate) {
          fields.id.setCustomValidity("このKoe IDはすでに使われています。");
        }

        var iconUrl = optionalTrimmed(fields.iconUrl);
        var iconEmoji = optionalTrimmed(fields.iconEmoji);
        var currentAgent = selectedAgent();
        if (
          currentAgent &&
          currentAgent.slack.conversation_scope === "slack_thread" &&
          fields.conversationScope.value === "channel" &&
          !fields.adapterSessionId.value.trim()
        ) {
          fields.adapterSessionId.disabled = false;
          fields.adapterSessionId.setCustomValidity("チャンネル共有へ戻すときは、共有するCodexスレッドIDを指定してください。");
        } else {
          fields.adapterSessionId.setCustomValidity("");
        }
        if (iconUrl && !iconUrl.startsWith("https://") && !isEnvironmentReference(iconUrl)) {
          fields.iconUrl.setCustomValidity("HTTPSのURLを入力してください。");
        }
        if (iconUrl && iconEmoji) {
          fields.iconEmoji.setCustomValidity("アイコンURLと絵文字は、どちらか一方だけ指定してください。");
        }

        elements.consultationList.querySelectorAll(".consultation-row").forEach(function (row) {
          var checkbox = row.querySelector('input[type="checkbox"]');
          var scope = row.querySelector("textarea");
          scope.setCustomValidity(checkbox.checked && !scope.value.trim() ? "相談できる範囲を入力してください。" : "");
        });

        if (!elements.editorForm.reportValidity()) {
          return null;
        }

        var consultations = Object.create(null);
        elements.consultationList.querySelectorAll(".consultation-row").forEach(function (row) {
          var checkbox = row.querySelector('input[type="checkbox"]');
          var scope = row.querySelector("textarea");
          if (checkbox.checked) {
            consultations[row.dataset.targetId] = { scope: scope.value };
          }
        });

        return {
          id: nextId,
          adapter: fields.adapter.value.trim(),
          adapter_session_id: fields.conversationScope.value === "channel"
            ? optionalTrimmed(fields.adapterSessionId)
            : undefined,
          model: optionalTrimmed(fields.model),
          reasoning_effort: optionalTrimmed(fields.reasoningEffort),
          automatic_choice_mode: "off",
          workspace_git_autonomy: undefined,
          workspace_path: fields.workspacePath.value.trim(),
          slack: {
            channel_id: fields.channelId.value.trim(),
            conversation_scope: fields.conversationScope.value,
            call_name: optionalTrimmed(fields.callName),
            persona: optionalPersona(fields.persona),
            display_name: optionalTrimmed(fields.displayName),
            icon_url: iconUrl,
            icon_emoji: iconEmoji
          },
          role: fields.role.value,
          consultations: consultations
        };
      }

      function renameConsultationTarget(agent, oldId, newId) {
        if (oldId === newId) {
          return agent;
        }
        var consultations = Object.create(null);
        Object.entries(agent.consultations).forEach(function (entry) {
          consultations[entry[0] === oldId ? newId : entry[0]] = { scope: entry[1].scope };
        });
        return {
          id: agent.id,
          adapter: agent.adapter,
          adapter_session_id: agent.adapter_session_id,
          model: agent.model,
          reasoning_effort: agent.reasoning_effort,
          automatic_choice_mode: agent.automatic_choice_mode,
          workspace_git_autonomy: agent.workspace_git_autonomy,
          workspace_path: agent.workspace_path,
          slack: agent.slack,
          role: agent.role,
          consultations: consultations
        };
      }

      function buildUpdatedConfig(nextAgent) {
        var current = selectedAgent();
        var oldId = current.id;
        var nextAgents = state.config.agents.map(function (agent, index) {
          var candidate = index === state.selectedIndex ? nextAgent : agent;
          return agentForUpdate(renameConsultationTarget(candidate, oldId, nextAgent.id));
        });
        return { revision: state.config.revision, agents: nextAgents };
      }

      function agentForUpdate(agent) {
        return {
          id: agent.id,
          adapter: agent.adapter,
          adapter_session_id: agent.adapter_session_id,
          model: agent.model,
          reasoning_effort: agent.reasoning_effort,
          automatic_choice_mode: agent.automatic_choice_mode,
          workspace_git_autonomy: agent.workspace_git_autonomy,
          workspace_path: agent.workspace_path,
          slack: agent.slack,
          role: agent.role,
          consultations: agent.consultations
        };
      }

      function confirmSensitiveChanges(current, nextAgent) {
        var warnings = [];
        if (current.slack.channel_id !== nextAgent.slack.channel_id) {
          warnings.push("Slackチャンネルを移動し、古い返信位置と共有スレッド選択を解除します。session IDを指定しなければ新しいCodexスレッドを作ります。");
        }
        if (current.workspace_path !== nextAgent.workspace_path) {
          warnings.push("Workspaceを変更し、旧Workspaceに結び付いたSlack返信位置を解除します。");
        }
        if (JSON.stringify(current.consultations) !== JSON.stringify(nextAgent.consultations)) {
          warnings.push("Koe間の相談許可を変更します。これはagent.sendの権限変更です。");
        }
        if (current.automatic_choice_mode !== nextAgent.automatic_choice_mode && nextAgent.automatic_choice_mode === "ordinary_top_choice") {
          warnings.push("通常の固定選択肢では、Koeが一番上の案を人間の確認なしで選んで処理を続けます。保護された承認は対象外です。");
        }
        if (JSON.stringify(current.workspace_git_autonomy) !== JSON.stringify(nextAgent.workspace_git_autonomy)) {
          warnings.push("Workspace Git自動運転のprofile候補を変更します。保存だけではONにならず、Slack上の独立確認が必要です。すでにONの場合は先にOFFしてください。");
        }
        return warnings.length === 0 || window.confirm(warnings.join("\n\n") + "\n\nこの内容で保存しますか？");
      }

      async function saveConfig(event) {
        event.preventDefault();
        if (state.busy || !selectedAgent()) {
          return;
        }
        var nextAgent = collectAgentFromForm();
        if (!nextAgent) {
          showToast("入力内容を確認してください。", "error");
          return;
        }
        if (!confirmSensitiveChanges(selectedAgent(), nextAgent)) {
          return;
        }
        var outgoing = buildUpdatedConfig(nextAgent);
        setBusy(true);
        setConnection("loading", "設定を保存中");
        elements.saveNote.textContent = "Gatewayへ設定を送信しています…";
        try {
          var response = await fetch("/api/config", {
            method: "PUT",
            credentials: "same-origin",
            headers: apiHeaders({
              "content-type": "application/json",
              "x-showtalk-csrf": csrfToken
            }),
            body: JSON.stringify(outgoing)
          });
          await requireSuccessfulResponse(response);
          var selectedId = nextAgent.id;
          state.config = normalizeConfig(await response.json());
          await loadAutonomyStatuses();
          state.selectedIndex = Math.max(0, state.config.agents.findIndex(function (agent) {
            return agent.id === selectedId;
          }));
          state.dirty = false;
          elements.saveNote.textContent = "保存しました。";
          setConnection("ready", "設定を保存済み");
          renderAll();
          showToast("Koe設定を保存しました。", "success");
        } catch (error) {
          state.dirty = true;
          elements.saveNote.textContent = "保存できませんでした。入力内容は画面に残っています。";
          if (isAuthenticationError(error)) {
            showAuthGate(error.message);
          } else {
            setConnection("error", "保存に失敗");
          }
          showToast("保存できませんでした: " + (error instanceof Error ? error.message : String(error)), "error");
        } finally {
          setBusy(false);
        }
      }

      async function loadConfig(announce) {
        if (state.busy) {
          return;
        }
        if (state.dirty && !window.confirm("未保存の変更を破棄して、設定を再読込しますか？")) {
          return;
        }
        setBusy(true);
        setConnection("loading", "設定を読み込み中");
        try {
          var response = await fetch("/api/config", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: apiHeaders()
          });
          await requireSuccessfulResponse(response);
          var config = normalizeConfig(await response.json());
          await loadAutonomyStatuses();
          state.config = config;
          state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, config.agents.length - 1));
          state.dirty = false;
          hideAuthGate();
          elements.saveNote.textContent = "編集内容はまだありません。";
          setConnection("ready", "設定を読込済み");
          renderAll();
          if (announce) {
            showToast("最新の設定を読み込みました。", "success");
          }
        } catch (error) {
          state.config = null;
          state.dirty = false;
          if (isAuthenticationError(error)) {
            showAuthGate(error.message);
          } else {
            setConnection("error", "設定を読み込めません");
          }
          renderAll();
          showToast("設定を読み込めませんでした: " + (error instanceof Error ? error.message : String(error)), "error");
        } finally {
          setBusy(false);
        }
      }

      async function loadAutonomyStatuses() {
        var response = await fetch("/api/workspace-git-autonomy", {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          headers: apiHeaders()
        });
        await requireSuccessfulResponse(response);
        var payload = await response.json();
        if (!payload || !Array.isArray(payload.agents)) {
          throw new Error("自動運転状態の形式が正しくありません。");
        }
        var next = Object.create(null);
        payload.agents.forEach(function (entry) {
          if (!entry || typeof entry !== "object") {
            throw new Error("自動運転状態の形式が正しくありません。");
          }
          var koeId = requireString(entry.koeId, "autonomy.koeId");
          if (["unconfigured", "disabled", "enabled", "expired"].indexOf(entry.state) < 0) {
            throw new Error("自動運転状態に未対応の値があります。");
          }
          next[koeId] = entry;
        });
        state.autonomyStatuses = next;
      }

      async function requestAutonomyControl(operation) {
        var agent = selectedAgent();
        if (!agent || state.busy || state.dirty) {
          if (state.dirty) showToast("先にprofile候補の変更を保存してください。", "error");
          return;
        }
        setBusy(true);
        try {
          var response = await fetch(
            "/api/agents/" + encodeURIComponent(agent.id) + "/workspace-git-autonomy/" + operation,
            {
              method: "POST",
              credentials: "same-origin",
              headers: apiHeaders({ "x-showtalk-csrf": csrfToken })
            }
          );
          await requireSuccessfulResponse(response);
          showToast("KoeのSlackチャンネルへ確認カードを送りました。", "success");
        } catch (error) {
          if (isAuthenticationError(error)) showAuthGate(error.message);
          showToast("自動運転の確認を開始できませんでした: " + (error instanceof Error ? error.message : String(error)), "error");
        } finally {
          setBusy(false);
          renderEditor();
        }
      }

      function openRestartConfirmation() {
        if (state.busy) {
          return;
        }
        elements.restartDetail.textContent = state.dirty
          ? "未保存の変更は反映されません。進行中の処理の完了を待ってから再起動します。"
          : "進行中の処理の完了を待ってから再起動します。保存済みの設定だけが再起動後に使われます。";
        if (typeof elements.restartDialog.showModal === "function") {
          elements.restartDialog.showModal();
          return;
        }
        if (window.confirm("Gatewayを再起動しますか？")) {
          requestRestart();
        }
      }

      async function requestRestart() {
        if (state.busy) {
          return;
        }
        setBusy(true);
        setConnection("loading", "再起動を依頼中");
        var scheduled = false;
        try {
          var response = await fetch("/api/restart", {
            method: "POST",
            credentials: "same-origin",
            headers: apiHeaders({
              "x-showtalk-csrf": csrfToken
            })
          });
          await requireSuccessfulResponse(response);
          scheduled = true;
          setConnection("loading", "Gateway再起動待ち");
          showToast("Gatewayへ再起動を依頼しました。進行中の処理が終わるまで待機します。", "success");
          waitForGatewayReplacement(0);
        } catch (error) {
          if (isAuthenticationError(error)) {
            showAuthGate(error.message);
          } else {
            setConnection("error", "再起動の依頼に失敗");
          }
          showToast("再起動を依頼できませんでした: " + (error instanceof Error ? error.message : String(error)), "error");
        } finally {
          if (!scheduled) {
            setBusy(false);
          }
        }
      }

      async function waitForGatewayReplacement(attempt) {
        if (attempt >= 600) {
          setConnection("error", "再接続を確認できません");
          setBusy(false);
          showToast("10分以内に再接続を確認できませんでした。ページを再読み込みしてください。", "error");
          return;
        }
        try {
          var response = await fetch("/api/health", {
            method: "GET",
            credentials: "same-origin",
            cache: "no-store",
            headers: apiHeaders()
          });
          await requireSuccessfulResponse(response);
          if (response.ok) {
            var health = await response.json();
            if (health && health.status === "running") {
              window.location.reload();
              return;
            }
          }
        } catch (error) {
          if (isAuthenticationError(error)) {
            showAuthGate(error.message);
            setBusy(false);
            return;
          }
          setConnection("loading", "Gatewayを入れ替え中");
        }
        window.setTimeout(function () {
          waitForGatewayReplacement(attempt + 1);
        }, 1000);
      }

      elements.editorForm.addEventListener("submit", saveConfig);
      elements.editorForm.addEventListener("input", markDirty);
      elements.editorForm.addEventListener("change", markDirty);
      fields.conversationScope.addEventListener("change", syncAdapterSessionField);
      fields.model.addEventListener("change", function () {
        var agent = selectedAgent();
        var model = selectedCatalogModel();
        var inheritedEffort = agent ? agent.adapter_reasoning_effort : undefined;
        var inheritedSupported = Boolean(
          model && inheritedEffort && model.supported_reasoning_efforts.some(function (effort) {
            return effort.value === inheritedEffort;
          })
        );
        syncReasoningEffortOptions(
          model && inheritedEffort && !inheritedSupported
            ? model.default_reasoning_effort
            : ""
        );
      });
      elements.refreshModelsButton.addEventListener("click", function () {
        var agent = selectedAgent();
        if (agent) {
          void loadModelCatalog(agent.id, true);
        }
      });
      elements.enableAutonomyButton.addEventListener("click", function () {
        void requestAutonomyControl("enable");
      });
      elements.disableAutonomyButton.addEventListener("click", function () {
        void requestAutonomyControl("disable");
      });
      elements.reloadButton.addEventListener("click", function () { loadConfig(true); });
      elements.restartButton.addEventListener("click", openRestartConfirmation);
      elements.cancelRestartButton.addEventListener("click", function () {
        elements.restartDialog.close();
      });
      elements.confirmRestartButton.addEventListener("click", function () {
        elements.restartDialog.close();
        requestRestart();
      });
      elements.reconnectButton.addEventListener("click", function () {
        window.location.reload();
      });
      elements.restartDialog.addEventListener("click", function (event) {
        if (event.target === elements.restartDialog) {
          elements.restartDialog.close();
        }
      });
      window.addEventListener("beforeunload", function (event) {
        if (state.dirty) {
          event.preventDefault();
          event.returnValue = "";
        }
      });

      syncActionState();
      loadConfig(false);
    }());
  </script>
</body>
</html>`;
}
