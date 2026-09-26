export interface AcpPersonaIo {
  write(text: string): void;
  writeErr(text: string): void;
  exit(code: number): void;
  runCommand(
    command: string,
    cwd: string,
    done: (err: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
  ): void;
  closeInput(then: () => void): void;
  pauseInput(): void;
}

export interface AcpPersona {
  onFrame(frame: Record<string, unknown>): void;
  readonly ignoresSigterm: boolean;
  readonly needsKeepAlive: boolean;
}

export function createAcpPersona(opts: {
  env: Readonly<Record<string, string | undefined>>;
  pid: number;
  cwd: string;
  io: AcpPersonaIo;
}): AcpPersona;
