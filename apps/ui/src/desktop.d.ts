export {};

export interface KodexDesktopBridge {
  openExternal(url: string): Promise<void>;
  selectDirectory(): Promise<string | null>;
  selectFile(): Promise<string | null>;
}

declare global {
  interface Window {
    kodexDesktop?: Readonly<KodexDesktopBridge>;
  }
}
