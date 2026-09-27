import { describe, expect, it, vi } from 'vitest';
import { NexariRuntimeTerminatedError, createNexariRuntime, type NexariGuestRuntime } from './nexari-runtime';
import {
  NexariUnsupportedCapabilityError,
  createNexariBrowserRuntime,
  type NexariBrowserRuntime,
  type NexariFsEncoding,
} from './nexari-runtime-facade';
import { createNexariBrowserRuntimeBackend } from './browser-runtime';

/** Compile-time-invalid call shapes must still be testable at runtime. */
const invalidEncoding = (value: string) => value as unknown as NexariFsEncoding;

function createSpiedGuest(): NexariGuestRuntime {
  return {
    fs: {
      readFile: vi.fn().mockResolvedValue('contents'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue(['entry']),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    spawn: vi.fn().mockResolvedValue({
      stdout: new ReadableStream<string>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<string>({ start: (controller) => controller.close() }),
      exit: Promise.resolve(0),
      kill: () => undefined,
    }),
    teardown: vi.fn().mockResolvedValue(undefined),
  };
}

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
      input: new WritableStream<string>(),
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

  it('forwards interactive process stdin to the guest', async () => {
    const writes: string[] = [];
    const guest = createSpiedGuest();
    guest.spawn = vi.fn().mockResolvedValue({
      input: new WritableStream<string>({
        write: (data) => {
          writes.push(data);
        },
      }),
      stdout: new ReadableStream<string>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<string>({ start: (controller) => controller.close() }),
      exit: Promise.resolve(0),
      kill: () => undefined,
    });

    const runtime = createNexariRuntime({ boot: () => Promise.resolve(guest) });
    const facade = createNexariBrowserRuntime(runtime);
    await facade.boot();

    const process = await facade.spawn('sh');
    const writer = process.input.getWriter();
    await writer.write('echo ready\n');

    expect(writes).toEqual(['echo ready\n']);
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

  describe('fs option-shape guards', () => {
    it('accepts supported writeFile encodings and forwards the call unchanged', async () => {
      const guest = createSpiedGuest();
      const runtime = createNexariRuntime({ boot: () => Promise.resolve(guest) });
      const facade = createNexariBrowserRuntime(runtime);
      await facade.boot();

      await facade.fs.writeFile('a.txt', 'text');
      await facade.fs.writeFile('b.txt', new Uint8Array([1]), { encoding: 'utf8' });
      await facade.fs.writeFile('c.txt', 'text', 'utf-8');
      await facade.fs.writeFile('d.txt', 'text', {});
      await facade.fs.writeFile('e.txt', new Uint8Array([2]), { encoding: undefined });

      expect(guest.fs.writeFile).toHaveBeenCalledWith('a.txt', 'text');
      expect(guest.fs.writeFile).toHaveBeenCalledWith('b.txt', new Uint8Array([1]));
      expect(guest.fs.writeFile).toHaveBeenCalledWith('c.txt', 'text');
      expect(guest.fs.writeFile).toHaveBeenCalledWith('d.txt', 'text');
      expect(guest.fs.writeFile).toHaveBeenCalledWith('e.txt', new Uint8Array([2]));
      expect(guest.fs.writeFile).toHaveBeenCalledTimes(5);
    });

    it('fails typed on unsupported writeFile encodings before reaching the guest', async () => {
      const guest = createSpiedGuest();
      const runtime = createNexariRuntime({ boot: () => Promise.resolve(guest) });
      const facade = createNexariBrowserRuntime(runtime);
      await facade.boot();

      await expect(facade.fs.writeFile('a.txt', 'text', invalidEncoding('base64'))).rejects.toBeInstanceOf(
        NexariUnsupportedCapabilityError,
      );
      await expect(
        facade.fs.writeFile('a.txt', 'text', { encoding: invalidEncoding('latin1') }),
      ).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
      expect(guest.fs.writeFile).not.toHaveBeenCalled();
    });

    it('accepts supported readFile encodings and fails typed on unsupported ones', async () => {
      const guest = createSpiedGuest();
      const runtime = createNexariRuntime({ boot: () => Promise.resolve(guest) });
      const facade = createNexariBrowserRuntime(runtime);
      await facade.boot();

      await expect(facade.fs.readFile('a.txt')).resolves.toBe('contents');
      await expect(facade.fs.readFile('a.txt', 'utf8')).resolves.toBe('contents');
      await expect(facade.fs.readFile('a.txt', 'utf-8')).resolves.toBe('contents');
      await expect(facade.fs.readFile('a.txt', invalidEncoding('base64'))).rejects.toBeInstanceOf(
        NexariUnsupportedCapabilityError,
      );
      expect(guest.fs.readFile).toHaveBeenCalledTimes(3);
      expect(guest.fs.readFile).toHaveBeenNthCalledWith(3, 'a.txt', 'utf-8');
    });

    it('accepts plain readdir and fails typed on withFileTypes until dirent mapping exists', async () => {
      const guest = createSpiedGuest();
      const runtime = createNexariRuntime({ boot: () => Promise.resolve(guest) });
      const facade = createNexariBrowserRuntime(runtime);
      await facade.boot();

      await expect(facade.fs.readdir('.')).resolves.toEqual(['entry']);
      await expect(facade.fs.readdir('.', {})).resolves.toEqual(['entry']);
      await expect(facade.fs.readdir('.', { withFileTypes: true } as never)).rejects.toBeInstanceOf(
        NexariUnsupportedCapabilityError,
      );
      await expect(facade.fs.readdir('.', { unknown: true } as never)).rejects.toBeInstanceOf(
        NexariUnsupportedCapabilityError,
      );
      expect(guest.fs.readdir).toHaveBeenCalledTimes(2);
    });

    it('restricts mkdir and rm options to the supported boolean shapes', async () => {
      const guest = createSpiedGuest();
      const runtime = createNexariRuntime({ boot: () => Promise.resolve(guest) });
      const facade = createNexariBrowserRuntime(runtime);
      await facade.boot();

      await facade.fs.mkdir('dir', { recursive: true });
      await facade.fs.mkdir('dir2');
      await facade.fs.rm('f.txt', { recursive: true, force: true });
      await facade.fs.rm('g.txt');

      expect(guest.fs.mkdir).toHaveBeenCalledWith('dir', { recursive: true });
      expect(guest.fs.mkdir).toHaveBeenCalledWith('dir2', undefined);
      expect(guest.fs.rm).toHaveBeenCalledWith('f.txt', { recursive: true, force: true });
      expect(guest.fs.rm).toHaveBeenCalledWith('g.txt', undefined);

      await expect(facade.fs.mkdir('dir3', { unknown: true } as never)).rejects.toBeInstanceOf(
        NexariUnsupportedCapabilityError,
      );
      await expect(facade.fs.rm('h.txt', { force: 'yes' } as never)).rejects.toBeInstanceOf(
        NexariUnsupportedCapabilityError,
      );
      expect(guest.fs.mkdir).toHaveBeenCalledTimes(2);
      expect(guest.fs.rm).toHaveBeenCalledTimes(2);
    });
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
