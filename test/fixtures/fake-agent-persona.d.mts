export interface AgentPersonaIo {
  write(text: string): void;
  writeErr(text: string): void;
  setExitCode(code: number): void;
  runCommand(
    command: string,
    cwd: string,
    done: (
      err: (Error & { code?: number | string }) | null,
      stdout: string,
      stderr: string,
    ) => void,
  ): void;
  killSelf(signal: NodeJS.Signals): void;
  spawnGrandchild(): number | undefined;
  keepAlive(): void;
}

export interface AgentPersona {
  run(): Promise<void>;
  readonly ignoresSigterm: boolean;
}

export function createAgentPersona(opts: {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  pid: number;
  cwd: string;
  io: AgentPersonaIo;
}): AgentPersona;
