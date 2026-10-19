// Browser-side execution adapters. Normal workspace runs may use these
// runtimes; exam grading must continue using the authoritative server path.
const ClientExecution = (() => {
  const PYODIDE_VERSION = '0.27.7';
  const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
  const CLANG_WASM_VERSION = '0.3.0';
  const CLANG_WASM_SCRIPT = `https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@${CLANG_WASM_VERSION}/dist/clang-wasm.global.js`;
  const CLANG_WASM_ASSETS = `https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@${CLANG_WASM_VERSION}/assets/`;
  const DEFAULT_TIMEOUT_MS = 30000;
  let worker = null;
  let sequence = 0;
  const pending = new Map();

  function supports(language) {
    return ['python', 'c', 'cpp'].includes(String(language || '').toLowerCase());
  }

  function workerSource() {
    return `
      let pyodide = null;
      let clangWasm = null;
      const clangCompilers = new Map();
      const base = ${JSON.stringify(PYODIDE_BASE)};
      const clangScript = ${JSON.stringify(CLANG_WASM_SCRIPT)};
      const clangAssets = ${JSON.stringify(CLANG_WASM_ASSETS)};

      async function runtime() {
        if (!pyodide) {
          importScripts(base + 'pyodide.js');
          pyodide = await loadPyodide({ indexURL: base });
        }
        return pyodide;
      }

      async function clangRuntime(language) {
        if (!clangWasm) {
          importScripts(clangScript);
          clangWasm = self.clangWasm;
        }
        const key = language === 'c' ? 'c' : 'cpp';
        if (!clangCompilers.has(key)) {
          clangCompilers.set(key, clangWasm.createCompiler(key, {
            baseUrl: clangAssets,
            std: key === 'c' ? 'gnu17' : 'gnu++17'
          }));
        }
        return clangCompilers.get(key);
      }

      self.onmessage = async event => {
        const request = event.data || {};
        try {
          if (request.language === 'c' || request.language === 'cpp') {
            const compiler = await clangRuntime(request.language);
            const result = await compiler.run(String(request.code || ''), String(request.stdin || ''), {
              fileName: request.language === 'c' ? 'main.c' : 'main.cpp'
            });
            const diagnostics = Array.isArray(result.errors) ? result.errors.join('\\n') : '';
            const failedToCompile = result.exitCode === null || result.exitCode === undefined;
            self.postMessage({ id: request.id, ok: true, result: {
              status: 'ok',
              code: failedToCompile ? 1 : result.exitCode,
              stdout: result.stdout || '',
              stderr: diagnostics || result.stderr || '',
              runtime: 'clang-wasm',
              compileMs: result.compileMs,
              runMs: result.runMs
            }});
            return;
          }
          const python = await runtime();
          const input = String(request.stdin || '').split(/\\r?\\n/);
          let inputIndex = 0;
          let stdout = '';
          let stderr = '';
          python.setStdout({ batched: value => { stdout += String(value) + '\\n'; } });
          python.setStderr({ batched: value => { stderr += String(value) + '\\n'; } });
          python.setStdin({ stdin: () => inputIndex < input.length ? input[inputIndex++] : null });
          await python.runPythonAsync(String(request.code || ''));
          self.postMessage({ id: request.id, ok: true, result: {
            status: 'ok', code: 0, stdout, stderr, runtime: 'pyodide'
          }});
        } catch (error) {
          self.postMessage({ id: request.id, ok: true, result: {
            status: 'ok', code: 1, stdout: '', stderr: String(error && (error.message || error) || 'Python execution failed'), runtime: 'pyodide'
          }});
        }
      };
    `;
  }

  function destroyWorker() {
    if (worker) worker.terminate();
    worker = null;
    pending.forEach(item => item.reject(new Error('Client runtime stopped')));
    pending.clear();
  }

  function getWorker() {
    if (worker) return worker;
    const source = new Blob([workerSource()], { type: 'application/javascript' });
    worker = new Worker(URL.createObjectURL(source), { name: 'codeleaf-client-runtime' });
    worker.onmessage = event => {
      const message = event.data || {};
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.ok) item.resolve(message.result);
      else item.reject(new Error(message.error || 'Client execution failed'));
    };
    worker.onerror = event => {
      const error = new Error(event.message || 'Client runtime failed to load');
      pending.forEach(item => {
        clearTimeout(item.timer);
        item.reject(error);
      });
      pending.clear();
      destroyWorker();
    };
    return worker;
  }

  async function run(language, code, stdin, options = {}) {
    if (!supports(language) || typeof Worker === 'undefined' || typeof Blob === 'undefined') return null;
    const id = ++sequence;
    const timeout = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const started = performance.now();
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          destroyWorker();
          reject(new Error(`Client execution timed out after ${timeout}ms`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        getWorker().postMessage({ id, language: String(language || '').toLowerCase(), code, stdin });
      });
      result.duration = (performance.now() - started).toFixed(2);
      return result;
    } catch (error) {
      // A failed browser runtime should not make the workspace unusable. The
      // caller may safely fall back to the existing authenticated API runner.
      console.warn('[CodeLeaf] Browser runtime unavailable:', error.message);
      return null;
    }
  }

  return { supports, run, stop: destroyWorker };
})();
