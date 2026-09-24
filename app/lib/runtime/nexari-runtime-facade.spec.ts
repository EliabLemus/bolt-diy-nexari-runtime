import { describe, expect, it, vi } from 'vitest';
import { NexariRuntimeTerminatedError, createNexariRuntime, type NexariGuestRuntime } from './nexari-runtime';
import {
  NexariUnsupportedCapabilityError,
  createNexariBrowserRuntime,
  type NexariBrowserRuntime,
} from './nexari-runtime-facade';
import { createNexariBrowserRuntimeBackend } from './browser-runtime';

function createSyntheticGuest(): NexariGuestRuntime {
  const files = new Map<string, Uint8Array | string>();

  return {
    fs: {
      readFile: async (path: string, _encoding?: 'utf8' | 'utf-8') => {
        if (!files.has(path)) {
          throw new Error(`ENOENT: ${path}`);
        }

        return files.get(path)!;
      },
      writeFile: async (path: string, contents: Uint8Array | string) => {
        files.set(path, contents);
      },
      readdir: async () => [...files.keys()],
      mkdir: async () => undefined,
      rm: async (path: string) => {
        files.delete(path);
      },
    },
    spawn: async () => ({
      stdout: new ReadableStream<string>({
        start: (controller) => {
          controller.enqueue('out');
          controller.close();
        },
      }),
      stderr: new ReadableStream<string>({
        start: (controller) => {
          controller.enqueue('err');
          controller.close();
        },
      }),
      exit: Promise.resolve(0),
      kill: () => undefined,
    }),
    teardown: async () => undefined,
  };
}

function createReadyFacade() {
  const runtime = createNexariRuntime({ boot: () => Promise.resolve(createSyntheticGuest()) });
  const facade = createNexariBrowserRuntime(runtime);

  return { runtime, facade, ready: facade.boot() };
}

describe('createNexariBrowserRuntime', () => {
  it('reports the historical workdir without consulting the guest', async () => {
    const { facade } = await createReadyFacade();

    expect(facade.workdir).toBe('/home/project');
  });

  it('delegates filesystem basics to the booted guest', async () => {
    const { facade } = await createReadyFacade();

    await facade.fs.writeFile('README.md', 'hello');
    await expect(facade.fs.readFile('README.md', 'utf8')).resolves.toBe('hello');
    await expect(facade.fs.readdir('.')).resolves.toContain('README.md');
  });

  it('boots idempotently through the underlying adapter', async () => {
    const bootGuest = vi.fn(() => Promise.resolve(createSyntheticGuest()));
    const runtime = createNexariRuntime({ boot: bootGuest });
    const facade = createNexariBrowserRuntime(runtime);

    await facade.boot();
    await facade.boot();

    expect(bootGuest).toHaveBeenCalledOnce();
  });

  it('spawns guest processes in the WebContainer process shape with merged output', async () => {
    const { facade } = await createReadyFacade();
    const process = await facade.spawn('echo', ['hi']);

    expect(typeof process.kill).toBe('function');
    expect(typeof process.resize).toBe('function');

    const reader = process.output.getReader();
    const chunks: string[] = [];

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      chunks.push(value);
    }

    expect(chunks.sort()).toEqual(['err', 'out']);
    await expect(process.exit).resolves.toBe(0);
  });

  it('rejects writes to the unsupported process stdin lane with a typed error', async () => {
    const { facade } = await createReadyFacade();
    const process = await facade.spawn('sh');

    const writer = process.input.getWriter();

    await expect(writer.write('nope')).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
  });

  it('rejects guest-unsupported spawn options with a typed error', async () => {
    const { facade } = await createReadyFacade();

    await expect(facade.spawn('sh', [], { cwd: '/tmp' })).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
    await expect(
      facade.spawn('sh', [], { terminal: { cols: 80, rows: 15 } } as Parameters<NexariBrowserRuntime['spawn']>[2]),
    ).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
  });

  it('runs action-style commands through the adapter exec lane', async () => {
    const { facade } = await createReadyFacade();

    await expect(facade.runActionCommand('true')).resolves.toEqual({ stdout: 'out', stderr: 'err', exitCode: 0 });
  });

  it('fails typed before boot', async () => {
    const { facade, ready } = createReadyFacade();

    await expect(facade.fs.readdir('.')).rejects.toThrowError(/not completed booting/);
    await ready;
  });

  it('fails typed after teardown with the terminated error', async () => {
    const { facade, runtime } = await createReadyFacade();

    await facade.boot();
    await runtime.teardown();

    await expect(facade.fs.readdir('.')).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
  });

  it('fails typed on out-of-slice capabilities instead of silently no-oping', async () => {
    const { facade } = await createReadyFacade();

    expect(() => facade.on('preview-message', () => undefined)).toThrowError(NexariUnsupportedCapabilityError);
    expect(() => facade.internal.watchPaths({ include: [] }, () => undefined)).toThrowError(
      NexariUnsupportedCapabilityError,
    );
    await expect(facade.setPreviewScript('<script></script>')).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
  });
});

describe('createNexariBrowserRuntimeBackend', () => {
  it('boots the facade from an injected guest factory', async () => {
    const bootNexari = vi.fn(() =>
      Promise.resolve(createNexariRuntime({ boot: () => Promise.resolve(createSyntheticGuest()) })),
    );
    const runtime = await createNexariBrowserRuntimeBackend(bootNexari);

    expect(bootNexari).toHaveBeenCalledOnce();
    await expect(runtime.fs.readdir('.')).resolves.toEqual([]);
    expect(runtime.workdir).toBe('/home/project');
  });

  it('surfaces a failed guest boot as a typed rejection', async () => {
    const bootNexari = () => Promise.reject(new Error('guest unavailable'));

    await expect(createNexariBrowserRuntimeBackend(bootNexari)).rejects.toThrowError('guest unavailable');
  });
});
