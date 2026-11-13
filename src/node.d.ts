// worker 가 쓰는 Node 내장 모듈의 형 — Orca 형 묶음에 Node 형이 없어 쓰는 것만 적는다.
declare module 'node:child_process' {
  export function execFile(
    file: string,
    args: readonly string[],
    options: { timeout?: number; maxBuffer?: number },
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void
  ): unknown
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean
}

declare const process: { execPath: string }
