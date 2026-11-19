const { app, BrowserWindow, Menu, shell, protocol, session } = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');

let mainWindow;

// ── Google sign-in (removable): OAuth عبر المتصفح مع عنوان رجوع محلي 127.0.0.1 (بدون أي دومين وسيط) ──
const http = require('http');
const crypto = require('crypto');
const { ipcMain, net } = require('electron');

// Navigation and external-link policy
const APP_WEB_ORIGIN = 'https://posflowapp.pages.dev';
const DEV_ORIGIN = 'http://localhost:5173';
const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:', 'tel:', 'whatsapp:', 'tg:']);

const isDevRun = () => process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

/** True only when the parsed origin is the app itself (a substring match on the URL is not enough). */
function isAppOrigin(rawUrl) {
  try {
    const origin = new URL(rawUrl).origin;
    return origin === APP_WEB_ORIGIN || (isDevRun() && origin === DEV_ORIGIN);
  } catch {
    return false;
  }
}

/** Open a link in the system browser only for known-safe schemes. */
function openExternalSafely(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
      shell.openExternal(parsed.toString());
    }
  } catch {
    // ignore malformed URLs
  }
}

function loadGoogleDesktopConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'google-desktop.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && cfg.clientId && cfg.clientSecret) return cfg;
  } catch (_) { /* غير مضبوط */ }
  return null;
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// نستخدم شبكة Chromium (net.fetch) لأنها تحترم إعدادات النظام (بروكسي/VPN/IPv6) بخلاف https في Node
async function postForm(urlStr, form) {
  const res = await net.fetch(urlStr, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  let json = {};
  try { json = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, json };
}

function describeError(e) {
  if (!e) return 'unknown';
  const inner = Array.isArray(e.errors) && e.errors.length ? e.errors.map((x) => x && (x.code || x.message)).filter(Boolean).join(',') : '';
  return String(e.message || e.code || inner || e) + (inner ? ` [${inner}]` : '');
}

let googleFlowActive = false;

async function googleDesktopSignIn(nonceHashed) {
  const cfg = loadGoogleDesktopConfig();
  if (!cfg) return { ok: false, code: 'CONFIG', message: 'google desktop client not configured' };
  if (googleFlowActive) return { ok: false, code: 'BUSY', message: 'sign-in already in progress' };
  googleFlowActive = true;

  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  try {
    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const reqUrl = new URL(req.url, 'http://127.0.0.1');
        if (reqUrl.pathname !== '/') { res.writeHead(404); res.end(); return; }
        const err = reqUrl.searchParams.get('error');
        const gotCode = reqUrl.searchParams.get('code');
        const okState = reqUrl.searchParams.get('state') === state;
        const success = !err && !!gotCode && okState;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>PosFlow</title><body style="font-family:Segoe UI,Tahoma,sans-serif;background:#f5f7fb;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0"><div style="background:#fff;border-radius:18px;padding:28px 36px;box-shadow:0 8px 30px rgba(0,0,0,.08);text-align:center"><h2>${success ? 'تم تسجيل الدخول' : 'تعذّر تسجيل الدخول'}</h2><p style="color:#4b5563">${success ? 'يمكنك إغلاق هذه الصفحة والعودة إلى PosFlow.' : 'ارجع إلى التطبيق وحاول مرة أخرى.'}</p></div></body></html>`);
        clearTimeout(timer);
        server.close();
        if (success) resolve(gotCode); else reject(new Error(err || 'state mismatch'));
      });
      const timer = setTimeout(() => { server.close(); reject(new Error('timeout')); }, 3 * 60 * 1000);
      server.on('error', (e) => { clearTimeout(timer); reject(e); });
      server.listen(0, '127.0.0.1', () => {
        const redirectUri = `http://127.0.0.1:${server.address().port}`;
        server.redirectUri = redirectUri;
        const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
          client_id: cfg.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: 'openid email profile',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          nonce: nonceHashed || '',
          prompt: 'select_account',
        }).toString();
        shell.openExternal(authUrl);
      });
      server.redirectUriPromise = null;
      googleDesktopSignIn._server = server;
    });

    const redirectUri = googleDesktopSignIn._server.redirectUri;
    const tok = await postForm('https://oauth2.googleapis.com/token', {
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });
    if (tok.status !== 200 || !tok.json.id_token) {
      return { ok: false, code: 'GOOGLE_ERROR', message: String((tok.json && (tok.json.error_description || tok.json.error)) || 'token exchange failed') };
    }
    return { ok: true, idToken: tok.json.id_token };
  } catch (e) {
    return { ok: false, code: e && e.message === 'timeout' ? 'CANCELLED' : 'GOOGLE_ERROR', message: describeError(e) };
  } finally {
    googleFlowActive = false;
  }
}

ipcMain.on('posflow:google-available', (event) => { event.returnValue = !!loadGoogleDesktopConfig(); });
ipcMain.handle('posflow:google-signin', (_event, nonceHashed) => googleDesktopSignIn(String(nonceHashed || '')));

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    icon: path.join(__dirname, '../resources/icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: '#1a1a2e',
  });

  // Remove menu completely for clean native app look
  Menu.setApplicationMenu(null);

  // Load the application
  const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
  
  console.log('=== PosFlow Electron ===');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('isDev:', isDev);
  console.log('app.getAppPath():', app.getAppPath());
  console.log('process.resourcesPath:', process.resourcesPath);
  console.log('__dirname:', __dirname);
  
  if (isDev) {
    console.log('[DEV MODE] Loading from localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    // Production: Try multiple paths with detailed logging
    const possiblePaths = [
      path.join(process.resourcesPath, 'dist/index.html'),     // Packaged app (priority)
      path.join(app.getAppPath(), 'dist/index.html'),           // App installation path
      path.join(__dirname, '../dist/index.html'),               // Standard build relative to electron folder
      path.join(__dirname, 'dist/index.html'),                  // Electron subfolder
      path.join(process.cwd(), 'dist/index.html'),              // Working directory
    ];
    
    console.log('[PROD MODE] Searching for dist folder...');
    let distPath = null;
    
    for (const filePath of possiblePaths) {
      console.log('  Checking:', filePath, '...', fs.existsSync(filePath) ? '✓ FOUND' : '✗ NOT FOUND');
      if (fs.existsSync(filePath)) {
        distPath = path.dirname(filePath);
        console.log('✓ Found dist at:', distPath);
        break;
      }
    }
    
    if (distPath && fs.existsSync(path.join(distPath, 'index.html'))) {
      // Load index.html with hash routing support
      const indexPath = path.join(distPath, 'index.html');
      console.log('✓ Loading from:', indexPath);
      
      // Use loadURL with file:// protocol for proper routing
      const fileUrl = url.format({
        pathname: indexPath,
        protocol: 'file:',
        slashes: true,
        hash: '/' // Start at root hash route
      });
      
      console.log('File URL:', fileUrl);
      mainWindow.loadURL(fileUrl);
    } else {
      // Error: Local files not found
      console.error('✗ Local dist folder not found!');
      console.error('Possible solutions:');
      console.error('  1. Run "npm run build" to build the frontend');
      console.error('  2. Ensure dist folder is in the correct location');
      console.error('  3. Check that the Electron build includes the dist folder');
      
      // Show error page
      const errorPage = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>PosFlow - Error</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, segoe-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; }
            .container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; text-align: center; }
            h1 { color: #e53e3e; margin: 0 0 20px 0; }
            p { color: #4a5568; line-height: 1.6; margin: 10px 0; }
            code { background: #f7fafc; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
            button { background: #667eea; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; margin-top: 20px; }
            button:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>⚠️ خطأ في التحميل</h1>
            <p><strong>PosFlow - Build Error</strong></p>
            <p>لم يتم العثور على ملفات التطبيق المترجمة.</p>
            <p>The application build files were not found.</p>
            <p style="background: #f7fafc; padding: 12px; border-radius: 6px; margin: 20px 0; font-size: 14px;">
              Missing: <code>dist/index.html</code>
            </p>
            <p style="color: #718096; font-size: 14px;">
              الحل: شغّل <code>npm run build</code> قبل بناء النسخة المسطبة<br>
              Solution: Run <code>npm run build</code> before building the installer
            </p>
            <button onclick="fetch('https://posflowapp.pages.dev').then(() => window.location.href = 'https://posflowapp.pages.dev').catch(() => alert('Could not reach online version'))">التحميل من الإنترنت / Load from Web</button>
          </div>
        </body>
        </html>
      `;
      
      mainWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorPage)}`);
    }
  }

  // Handle navigation for SPA - redirect all routes to index.html
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsedUrl = new URL(navigationUrl);
    
    // Allow external URLs
    if (parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:') {
      if (!isAppOrigin(navigationUrl)) {
        event.preventDefault();
        openExternalSafely(navigationUrl);
      }
      return;
    }
    
    // For file:// protocol, prevent navigation and use hash routing
    if (parsedUrl.protocol === 'file:') {
      // Don't prevent if it's just loading index.html
      if (parsedUrl.pathname.endsWith('index.html')) {
        return;
      }
    }
  });

  // Handle load errors with detailed feedback
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error('❌ Failed to load:', errorCode, errorDescription, validatedURL);
    
    // Show user-friendly error
    const errorHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>PosFlow - Loading Error</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, segoe-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); margin: 0; }
          .container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; text-align: center; }
          h1 { color: #e53e3e; }
          p { color: #4a5568; }
          .error-code { background: #f7fafc; padding: 10px; border-radius: 6px; font-family: monospace; color: #c53030; margin: 15px 0; }
          button { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; margin: 10px 5px; }
          button:hover { background: #5568d3; }
          .small { font-size: 12px; color: #718096; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>❌ خطأ في التحميل</h1>
          <p><strong>Error Loading Application</strong></p>
          <div class="error-code">Error ${errorCode}: ${errorDescription}</div>
          <p class="small">الرجاء التأكد من أن النسخة تم بناؤها بشكل صحيح</p>
          <p>
            <button onclick="location.reload()">إعادة محاولة / Retry</button>
            <button onclick="fetch('https://posflowapp.pages.dev').then(() => window.location.href = 'https://posflowapp.pages.dev')">الإنترنت / Web</button>
          </p>
        </div>
      </body>
      </html>
    `;
    
    mainWindow.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml)}`);
  });

  // Handle crashed renderer
  mainWindow.webContents.on('crashed', () => {
    console.error('❌ Renderer process crashed!');
    // Optionally restart
    mainWindow.webContents.reloadIgnoringCache();
  });

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
}

// Register custom protocol handler for SPA
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const requestingUrl = (webContents && typeof webContents.getURL === 'function') ? webContents.getURL() : '';
    const fromApp = requestingUrl.startsWith('file://') || isAppOrigin(requestingUrl);
    if (fromApp && (permission === 'media' || permission === 'camera' || permission === 'microphone')) {
      callback(true);
      return;
    }
    callback(false);
  });

  // Handle file:// protocol for SPA routing
  protocol.interceptFileProtocol('file', (request, callback) => {
    let filePath = request.url.replace('file:///', '').replace('file://', '');
    
    // Decode URI components
    filePath = decodeURIComponent(filePath);
    
    // On Windows, paths might start with drive letter
    if (process.platform === 'win32' && filePath.startsWith('/')) {
      filePath = filePath.substring(1);
    }
    
    // Check if file exists
    if (fs.existsSync(filePath)) {
      callback({ path: filePath });
    } else {
      // For non-existent paths (SPA routes), serve index.html
      const possiblePaths = [
        path.join(process.resourcesPath, 'dist/index.html'),
        path.join(__dirname, '../dist/index.html'),
        path.join(__dirname, 'dist/index.html'),
      ];
      
      for (const indexPath of possiblePaths) {
        if (fs.existsSync(indexPath)) {
          callback({ path: indexPath });
          return;
        }
      }
      
      // File truly not found
      callback({ error: -6 }); // ERR_FILE_NOT_FOUND
    }
  });
  
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
