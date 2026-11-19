// جسر آمن (contextIsolation) لتسجيل الدخول بجوجل على الكمبيوتر — جزء من وحدة جوجل القابلة للإزالة
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posflowGoogle', {
  available: !!ipcRenderer.sendSync('posflow:google-available'),
  signIn: (nonceHashed) => ipcRenderer.invoke('posflow:google-signin', nonceHashed),
});
