import fs from 'node:fs';
import path from 'node:path';

export function browserExecutable() {
  const configured = process.env.RTSAI_CHROME_EXECUTABLE;
  const candidates = configured ? [configured] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright/chromium-1228/chrome-win64/chrome.exe')]
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error('No local Chromium executable; set RTSAI_CHROME_EXECUTABLE explicitly.');
  return found;
}

export function browserArgs() {
  return ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'win32' ? ['--use-angle=d3d11'] : [])];
}
