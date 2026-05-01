# Substitution Request Generator — Installation Guide

**(Codename: Skyfall) — For end users — 2026-04-22**

Install on macOS or Windows in about 5 minutes.

---

## System requirements

- **macOS:** 13.0 (Ventura) or later. Both Intel and Apple Silicon
  Macs are supported.
- **Windows:** Windows 10 (64-bit) or later.
- **Internet connection** required (for catalog sync and AI-powered
  matching/drafting).
- **Disk space:** ~500 MB available.

---

## macOS install

### 1. Download

You'll receive a `.dmg` file from the 007 Technologies team, or
download from
[https://github.com/007-technologies/substitution_request_tool/releases](https://github.com/007-technologies/substitution_request_tool/releases).

Look for: `Soprema Substitution Tool-1.x.x-arm64.dmg` (Apple
Silicon) or the universal / Intel variant.

### 2. Open the .dmg

Double-click the downloaded `.dmg`. A window opens showing the app
icon and an Applications shortcut.

### 3. Drag to Applications

Drag the app icon onto the Applications folder.

### 4. First launch

Open Applications. **Right-click** (or Control-click) the app and
choose **Open**.

macOS shows a warning:

> *"Substitution Request Generator" cannot be opened because the
> developer cannot be verified.*

Expected. Click **Open** to bypass. macOS remembers this choice.

### 5. Done

App is ready. See `USER-GUIDE.md` for the workflow.

---

## Windows install

### 1. Download

Look for: `Soprema Substitution Tool Setup 1.x.x.exe`.

### 2. Run the installer

Double-click the `.exe`.

### 3. Windows SmartScreen

> *Windows protected your PC — Microsoft Defender SmartScreen
> prevented an unrecognized app from starting.*

Click **More info** → **Run anyway**.

### 4. Installer wizard

- Accept the license agreement
- Default install location is fine (`C:\Program Files\Soprema
  Substitution Tool`)
- Click through to completion

### 5. Launch

The installer launches the app at the end, or you can find it on
the Start menu / desktop.

---

## Updates

The app checks for updates on launch. When a new version is
available, you'll see an update banner.

- Click **Update now** to download and install immediately (the app
  restarts).
- Click **Remind me later** to defer.

Updates are typically 10–50 MB and install in under a minute.

---

## First-time setup (inside the app)

On first launch, the app:

1. **Downloads the catalog** from the cloud (about 10 MB — the
  Soprema product catalog with ~N products and associated
  metadata). Progress bar shows. Takes 10–30 seconds.
2. **Validates your license / API access.** For piloted
  installations, access is baked into the build. For
  customer-specific installations, your activation key is embedded
  at build time.

Once these complete, you'll see the main workflow view.

---

## Uninstall

### macOS

Drag the app from Applications to Trash. Empty the Trash.

Optionally remove local catalog cache and session data:

```
~/Library/Application Support/Soprema Substitution Tool/
```

### Windows

Control Panel → Programs → Uninstall. Select the app and uninstall.

Optionally remove local data:

```
C:\Users\[YourUsername]\AppData\Roaming\Soprema Substitution Tool\
```

---

## Troubleshooting

**"Couldn't download catalog"** — the app couldn't reach our
catalog host (Cloudflare R2). Check your internet connection. If on
a corporate network, ask IT to allow-list
`*.r2.cloudflarestorage.com`.

**"Invalid Anthropic API key"** — the build is missing the embedded
API key. Email support for a fresh installer.

**"Too many requests"** — AI rate limit hit. Wait 30 seconds and
try again.

**App crashes on launch (macOS)** — try the right-click → Open
method (not double-click). Unsigned apps sometimes behave this way
the first time.

**App doesn't appear in Start menu (Windows)** — run the installer
as administrator (right-click the installer → Run as administrator).

---

## Support

`support@007technologies.com`

Include:
- OS + version
- App version (visible in the About menu)
- Screenshot of any error
- What step you were on

Expected response: within 1 business day.
