// Browser-side execution adapters. Normal workspace runs may use these
// runtimes; exam grading must continue using the authoritative server path.
const ClientExecution = (() => {
  const PYODIDE_VERSION = '0.27.7';
  const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
  const CLANG_WASM_VERSION = '0.3.0';
  const CLANG_WASM_SCRIPT = `https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@${CLANG_WASM_VERSION}/dist/clang-wasm.global.js`;
  const CLANG_WASM_ASSETS = `https://cdn.jsdelivr.net/npm/@live-codes/clang-wasm@${CLANG_WASM_VERSION}/assets/`;
  // Blob workers do not have the application page as their URL base, so
  // root-relative asset paths would fail to parse inside the worker.
  const TEAVM_ASSET_BASE = new URL('/assets/teavm/', window.location.href).href;
  const TEAVM_COMPILER = `${TEAVM_ASSET_BASE}compiler.wasm`;
  const TEAVM_RUNTIME = `${TEAVM_ASSET_BASE}compiler.wasm-runtime.js`;
  const TEAVM_SDK = `${TEAVM_ASSET_BASE}compile-classlib-teavm.bin`;
  const TEAVM_CLASSLIB = `${TEAVM_ASSET_BASE}runtime-classlib-teavm.bin`;
  const DEFAULT_TIMEOUT_MS = 30000;
  let worker = null;
  let sequence = 0;
  const pending = new Map();

  function supports(language) {
    return ['python', 'c', 'cpp', 'java'].includes(String(language || '').toLowerCase());
  }

  function workerSource() {
    return `
      let pyodide = null;
      let codeleafClangRuntime = null;
      let codeleafClangBundleLoaded = false;
      const codeleafClangCompilers = new Map();
      let javaRuntime = null;
      let javaCompiler = null;
      let javaSdk = null;
      let javaClasslib = null;
      const base = ${JSON.stringify(PYODIDE_BASE)};
      const clangScript = ${JSON.stringify(CLANG_WASM_SCRIPT)};
      const clangAssets = ${JSON.stringify(CLANG_WASM_ASSETS)};
      const javaCompilerWasm = ${JSON.stringify(TEAVM_COMPILER)};
      const javaRuntimeScript = ${JSON.stringify(TEAVM_RUNTIME)};
      const javaSdkUrl = ${JSON.stringify(TEAVM_SDK)};
      const javaClasslibUrl = ${JSON.stringify(TEAVM_CLASSLIB)};
      const scannerShim = stdinValue => {
        // Build a Java string literal directly. JSON.stringify would escape
        // the already-escaped newline a second time, making Scanner read the
        // literal characters "\\n" instead of a line break.
        const escapedInput = '"' + String(stdinValue || '')
          .split(String.fromCharCode(92)).join(String.fromCharCode(92, 92))
          .split(String.fromCharCode(34)).join(String.fromCharCode(92, 34))
          .split(String.fromCharCode(13)).join(String.fromCharCode(92, 114))
          .split(String.fromCharCode(10)).join(String.fromCharCode(92, 110))
          .split(String.fromCharCode(9)).join(String.fromCharCode(92, 116))
          .split(String.fromCharCode(12)).join(String.fromCharCode(92, 102)) + '"';
        return 'import java.io.InputStream;\\n' +
        'public final class Scanner {\\n' +
        '  private static final String CODELEAF_INPUT = ' + escapedInput + ';\\n' +
        '  private static int position = 0;\\n' +
        '  public Scanner(InputStream input) { }\\n' +
        '  private int readChar() { return position < CODELEAF_INPUT.length() ? CODELEAF_INPUT.charAt(position++) : -1; }\\n' +
        '  public String nextLine() { StringBuilder value = new StringBuilder(); int ch; while ((ch = readChar()) != -1 && ch != 10) { if (ch != 13) value.append((char) ch); } return value.toString(); }\\n' +
        '  public String next() { StringBuilder value = new StringBuilder(); int ch; do { ch = readChar(); } while (ch != -1 && ch <= 32); while (ch != -1 && ch > 32) { value.append((char) ch); ch = readChar(); } return value.toString(); }\\n' +
        '  public int nextInt() { return Integer.parseInt(next()); }\\n' +
        '}';
      };
      const printfShim = 'public final class CodeLeafConsole {\\n' +
        '  private static String value(Object value) { return String.valueOf(value); }\\n' +
        '  private static String fixed(double value, int precision) {\\n' +
        '    long factor = 1; for (int i = 0; i < precision; i++) factor *= 10;\\n' +
        '    long scaled = Math.round(value * factor); boolean negative = scaled < 0;\\n' +
        '    long magnitude = negative ? -scaled : scaled; long whole = magnitude / factor;\\n' +
        '    long fraction = magnitude % factor; String result = (negative ? "-" : "") + String.valueOf(whole);\\n' +
        '    if (precision == 0) return result;\\n' +
        '    String digits = String.valueOf(fraction); while (digits.length() < precision) digits = "0" + digits;\\n' +
        '    return result + "." + digits;\\n' +
        '  }\\n' +
        '  public static void printf(String format, Object... args) {\\n' +
        '    StringBuilder output = new StringBuilder(); int arg = 0;\\n' +
        '    for (int i = 0; i < format.length(); i++) {\\n' +
        '      char ch = format.charAt(i);\\n' +
        '      if (ch != 37 || i + 1 >= format.length()) { output.append(ch); continue; }\\n' +
        '      i++; ch = format.charAt(i);\\n' +
        '      if (ch == 37) { output.append(37); continue; }\\n' +
        '      if (ch == 110) { output.append((char) 10); continue; }\\n' +
        '      int precision = -1;\\n' +
        '      if (ch == 46) { precision = 0; i++; while (i < format.length() && format.charAt(i) >= 48 && format.charAt(i) <= 57) { precision = precision * 10 + format.charAt(i) - 48; i++; } if (i >= format.length()) break; ch = format.charAt(i); }\\n' +
        '      Object item = arg < args.length ? args[arg++] : null;\\n' +
        '      if (ch == 102 && precision >= 0 && item instanceof Double) { output.append(fixed(((Double) item).doubleValue(), precision)); } else { output.append(value(item)); }\\n' +
        '    }\\n' +
        '    System.out.print(output.toString());\\n' +
        '  }\\n' +
        '}';

      async function runtime() {
        if (!pyodide) {
          importScripts(base + 'pyodide.js');
          pyodide = await loadPyodide({ indexURL: base });
        }
        return pyodide;
      }

      async function clangRuntime(language) {
        if (!codeleafClangRuntime) {
          // Blob workers can reject a direct cross-origin importScripts call
          // even when the CDN sends permissive CORS headers. Fetching the
          // bundle first, then importing a same-worker blob, keeps the
          // compiler client-side while avoiding that browser restriction.
          if (!codeleafClangBundleLoaded) {
            const response = await fetch(clangScript, { mode: 'cors', cache: 'force-cache' });
            if (!response.ok) throw new Error('Clang runtime download failed (' + response.status + ')');
            const source = await response.text();
            const bundle = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
            try {
              importScripts(bundle);
              codeleafClangBundleLoaded = true;
            } finally {
              URL.revokeObjectURL(bundle);
            }
          }
          codeleafClangRuntime = self.clangWasm;
        }
        const key = language === 'c' ? 'c' : 'cpp';
        if (!codeleafClangCompilers.has(key)) {
          codeleafClangCompilers.set(key, codeleafClangRuntime.createCompiler(key, {
            baseUrl: clangAssets,
            std: key === 'c' ? 'gnu17' : 'gnu++17'
          }));
        }
        return codeleafClangCompilers.get(key);
      }

      async function javaRuntimeReady() {
        if (javaCompiler) return javaCompiler;
        // Blob workers may reject a direct cross-origin dynamic import even
        // when the CDN permits CORS. Fetch the ES module first and import a
        // same-worker Blob URL instead.
        const runtimeResponse = await fetch(javaRuntimeScript, { mode: 'cors', cache: 'force-cache' });
        if (!runtimeResponse.ok) throw new Error('TeaVM runtime download failed (' + runtimeResponse.status + ')');
        const runtimeSource = await runtimeResponse.text();
        const runtimeBlob = URL.createObjectURL(new Blob([runtimeSource], { type: 'application/javascript' }));
        try {
          javaRuntime = await import(runtimeBlob);
        } finally {
          URL.revokeObjectURL(runtimeBlob);
        }
        const compilerModule = await javaRuntime.load(javaCompilerWasm);
        javaCompiler = compilerModule.exports.createCompiler();
        const fetchBinaryAsset = async (url, label) => {
          try {
            const response = await fetch(url, { mode: 'same-origin', cache: 'force-cache' });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return new Int8Array(await response.arrayBuffer());
          } catch (error) {
            throw new Error(label + ' unavailable: ' + (error && error.message || error));
          }
        };
        javaSdk = await fetchBinaryAsset(javaSdkUrl, 'Java compiler library');
        javaClasslib = await fetchBinaryAsset(javaClasslibUrl, 'Java runtime library');
        javaCompiler.setSdk(javaSdk);
        javaCompiler.setTeaVMClasslib(javaClasslib);
        return javaCompiler;
      }

      async function runJava(code, stdin, fileName, report) {
        // TeaVM can retain generated source/class state between compiler
        // invocations. Recreate only the compiler so Scanner gets the
        // current run's stdin literal; the downloaded runtime is reused.
        javaCompiler = null;
        const compiler = await javaRuntimeReady();
        if (report) report('compiling', 'Compiling Java source…');
        if (compiler.clearSourceFiles) compiler.clearSourceFiles();
        if (compiler.clearInputClassFiles) compiler.clearInputClassFiles();
        if (compiler.clearOutputFiles) compiler.clearOutputFiles();

        const diagnostics = [];
        const registration = compiler.onDiagnostic(diagnostic => {
          if (diagnostic && diagnostic.message) diagnostics.push(diagnostic.message);
        });
        const sourceName = String(fileName || 'Main.java').split(/[\\/]/).pop() || 'Main.java';
        let sourceText = String(code || '');
        // Keep this detection regex-free: this file is embedded inside a
        // worker template, where regex escaping can corrupt the worker code.
        const usesPrintf = sourceText.indexOf('System.out.printf') !== -1;
        if (usesPrintf) {
          // TeaVM's Formatter implementation is incomplete in the browser;
          // route common console formatting through a small local shim.
          sourceText = sourceText.split('System.out.printf(').join('CodeLeafConsole.printf(');
          sourceText = sourceText.split('System.out.printf (').join('CodeLeafConsole.printf(');
          compiler.addSourceFile('CodeLeafConsole.java', printfShim);
        }
        if (/\\bScanner\\b/.test(sourceText)) {
          // TeaVM cannot add classes to java.base, so provide Scanner in the
          // source's default package. Remove only an explicit Scanner import;
          // wildcard imports remain harmless and existing code stays intact.
          sourceText = sourceText.replace(/^\\s*import\\s+java\\.util\\.Scanner\\s*;\\s*$/gm, '');
          compiler.addSourceFile('Scanner.java', scannerShim(stdin));
        }
        compiler.addSourceFile(sourceName, sourceText);
        const compiled = compiler.compile();
        if (registration && registration.destroy) registration.destroy();
        if (!compiled) {
          return { status: 'ok', code: 1, stdout: '', stderr: diagnostics.join('\\n') || 'Java compilation failed.', runtime: 'teavm-javac' };
        }

        const mainClasses = compiler.detectMainClasses();
        if (!mainClasses || !mainClasses.length) {
          return { status: 'ok', code: 1, stdout: '', stderr: 'No public static void main(String[] args) method was found.', runtime: 'teavm-javac' };
        }
        // TeaVM may retain an output artifact when a compiler instance is
        // reused. A unique module name guarantees that changed stdin/source
        // cannot execute a previous run's WebAssembly.
        const outputName = 'codeleaf-java-' + Date.now().toString(36);
        if (report) report('generating', 'Generating WebAssembly…');
        if (!compiler.generateWebAssembly({ outputName, mainClass: mainClasses[0] })) {
          return { status: 'ok', code: 1, stdout: '', stderr: diagnostics.join('\\n') || 'Java WebAssembly generation failed.', runtime: 'teavm-javac' };
        }
        const generated = compiler.getWebAssemblyOutputFile(outputName + '.wasm');
        let stdout = '';
        let stderr = '';
        const input = String(stdin || '').split(/\\r?\\n/);
        let inputIndex = 0;
        let inputBuffer = '';
        if (report) report('running', 'Running Java program on this device…');
        const module = await javaRuntime.load(generated, {
          installImports(imports) {
            imports.teavmConsole.putcharStdout = ch => { stdout += String.fromCharCode(ch); };
            imports.teavmConsole.putcharStderr = ch => { stderr += String.fromCharCode(ch); };
            const readInput = () => {
              if (!inputBuffer && inputIndex < input.length) inputBuffer = input[inputIndex++] + '\\n';
              if (!inputBuffer) return -1;
              const character = inputBuffer.charCodeAt(0);
              inputBuffer = inputBuffer.slice(1);
              return character;
            };
            imports.teavmConsole.getcharStdin = readInput;
          }
        });
        await module.exports.main([]);
        return { status: 'ok', code: 0, stdout, stderr, runtime: 'teavm-javac' };
      }

      function reportProgress(id, phase, detail) {
        self.postMessage({ id, type: 'progress', progress: { phase, detail } });
      }

      self.onmessage = async event => {
        const request = event.data || {};
        try {
          reportProgress(request.id, 'loading', 'Loading ' + request.language + ' runtime…');
          if (request.language === 'c' || request.language === 'cpp') {
            // Keep each compilation isolated so a previous run cannot retain
            // its stdin or generated program state.
            codeleafClangCompilers.delete(request.language);
            const compiler = await clangRuntime(request.language);
            reportProgress(request.id, 'compiling', 'Compiling ' + request.language.toUpperCase() + ' source…');
            const result = await compiler.run(String(request.code || ''), String(request.stdin || ''), {
              fileName: request.language === 'c' ? 'main.c' : 'main.cpp'
            });
            reportProgress(request.id, 'completed', 'Program finished on this device.');
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
          if (request.language === 'java') {
            try {
              const result = await runJava(request.code, request.stdin, request.fileName,
                (phase, detail) => reportProgress(request.id, phase, detail));
              reportProgress(request.id, 'completed', 'Program finished on this device.');
              self.postMessage({ id: request.id, ok: true, result });
            } catch (error) {
              // A Java runtime exception (for example an unsupported TeaVM
              // class-library path) means the device runtime failed. Mark it
              // distinctly so the application can retry on the remote worker.
              self.postMessage({ id: request.id, ok: true, result: {
                status: 'ok',
                code: 1,
                stdout: '',
                stderr: String(error && (error.message || error) || 'Java runtime failed'),
                runtime: 'codeleaf-browser',
                executionFailure: true
              }});
            }
            return;
          }
          const python = await runtime();
          reportProgress(request.id, 'compiling', 'Preparing Python program…');
          const input = String(request.stdin || '').split(/\\r?\\n/);
          let inputIndex = 0;
          let stdout = '';
          let stderr = '';
          python.setStdout({ batched: value => { stdout += String(value) + '\\n'; } });
          python.setStderr({ batched: value => { stderr += String(value) + '\\n'; } });
          python.setStdin({ stdin: () => inputIndex < input.length ? input[inputIndex++] : null });
          await python.runPythonAsync(String(request.code || ''));
          reportProgress(request.id, 'completed', 'Program finished on this device.');
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
      if (message.type === 'progress') {
        if (item.onProgress) item.onProgress(message.progress || {});
        return;
      }
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
    const normalizedLanguage = String(language || '').toLowerCase();
    if (!supports(normalizedLanguage)) return null;
    const id = ++sequence;
    const timeout = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const started = performance.now();
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      return {
        status: 'ok',
        code: 1,
        stdout: '',
        stderr: 'On-device execution is unavailable because this browser does not support Web Workers.',
        runtime: 'codeleaf-browser'
      };
    }
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          destroyWorker();
          reject(new Error(`Client execution timed out after ${timeout}ms`));
        }, timeout);
        pending.set(id, { resolve, reject, timer, onProgress: options.onProgress });
        getWorker().postMessage({ id, language: String(language || '').toLowerCase(), code, stdin, fileName: options.fileName || '' });
      });
      result.duration = (performance.now() - started).toFixed(2);
      return result;
    } catch (error) {
      // Supported languages are intentionally device-only. Do not silently
      // forward source code to the remote executor when a local runtime fails.
      const message = error && error.message ? error.message : String(error || 'Client runtime failed');
      console.error('[CodeLeaf] On-device runtime failed:', message);
      return {
        status: 'ok',
        code: 1,
        stdout: '',
        stderr: `On-device ${normalizedLanguage} execution failed: ${message}`,
        runtime: 'codeleaf-browser',
        duration: (performance.now() - started).toFixed(2)
      };
    }
  }

  return { supports, run, stop: destroyWorker };
})();
