export function createControlPlaneShutdown(options: {
  stopInputs: () => Promise<void>;
  stopServer: () => Promise<void>;
  closeServices: () => Promise<void>;
  onComplete?: () => void;
}): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    shutdownPromise ??= run();
    return shutdownPromise;
  };

  async function run(): Promise<void> {
    await options.stopInputs();
    await options.stopServer();
    await options.closeServices();
    options.onComplete?.();
  }
}
