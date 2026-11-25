// Types for the Node built-ins the worker uses — Orca's type bundle has none for Node, so only what is used is declared.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { timeout?: number; maxBuffer?: number; cwd?: string },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function statSync(path: string, options: { throwIfNoEntry: false }): { isFile(): boolean; isDirectory(): boolean; size: number } | undefined
  export function readFileSync(path: string, encoding: 'utf8'): string
}

declare module 'node:os' {
  export function homedir(): string
}

declare const process: { execPath: string; platform: string; env: Record<string, string | undefined> }

declare module 'node:test' {
  /** Fake timers — the one part a test here uses, to fire the worker's 30-second timer by hand. */
  export const mock: {
    timers: { enable(options: { apis: ('setInterval' | 'setTimeout')[] }): void; tick(ms: number): void; reset(): void }
  }
}
