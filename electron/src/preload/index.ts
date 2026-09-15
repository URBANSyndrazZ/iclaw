import { contextBridge, ipcRenderer } from 'electron';

export interface iclawDesktopConfig {
  appName: string;
  version: string;
  serverUrl: string;
  rendererUrl: string;
  isPackaged: boolean;
}

export interface iclawDesktopAPI {
  getConfig(): Promise<iclawDesktopConfig>;
  openExternal(url: string): Promise<void>;
  retry(): Promise<void>;
  reload(): void;
  showAbout(): Promise<void>;
}

const api: iclawDesktopAPI = {
  getConfig: () => ipcRenderer.invoke('desktop:get-config'),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  reload: () => ipcRenderer.send('desktop:reload'),
  showAbout: () => ipcRenderer.invoke('desktop:show-about'),
};

contextBridge.exposeInMainWorld('iclawDesktop', api);
