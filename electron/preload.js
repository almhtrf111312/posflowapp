// جسر آمن (contextIsolation) لتسجيل الدخول بجوجل على الكمبيوتر — جزء من وحدة جوجل القابلة للإزالة
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowposGoogle', {
  available: !!ipcRenderer.sendSync('flowpos:google-available'),
  signIn: (nonceHashed) => ipcRenderer.invoke('flowpos:google-signin', nonceHashed),
});
