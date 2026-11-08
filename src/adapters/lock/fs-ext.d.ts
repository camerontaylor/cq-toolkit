/** Minimal types for the private native adapter; fs-ext ships no declarations. */
declare module 'fs-ext' {
  const binding: { flockSync(fd: number, operation: string): void };
  export default binding;
}
