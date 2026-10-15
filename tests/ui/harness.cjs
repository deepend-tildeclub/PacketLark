// Test-only renderer host. Production uses src/main/index.ts and its isolated preload bridge.
const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1260,
    height: 820,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: process.env.RETROPOST_HEADLESS === '1',
    },
  });
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
