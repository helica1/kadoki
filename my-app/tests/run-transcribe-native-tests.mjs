// macOS 26 / Xcode 26 required. Compiles the actual TranscribeJob against
// Apple Speech + AVFoundation. Only UIKit battery state is shimmed; no model
// download, speech inference, simulator or project changes are needed.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../ios/App/App/AutoTranscribePlugin.swift', import.meta.url), 'utf8');
const marker = '// MARK: - TranscribeJob';
if (!source.includes(marker)) throw new Error('TranscribeJob source marker missing');
// Expose private methods in this test copy only, keeping production intact.
const job = source.slice(source.indexOf(marker)).replace(/\bprivate /g, '');
const harness = readFileSync(new URL('./transcribe-native-regression.swift', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'kadoki-native-power-tests-'));
const path = join(dir, 'Tests.swift');
writeFileSync(path, `import Foundation\nimport Speech\nimport AVFoundation\n
@MainActor final class UIDevice {
    enum BatteryState { case unknown, unplugged, charging, full }
    static let current = UIDevice()
    var isBatteryMonitoringEnabled = false
    var batteryState: BatteryState = .unplugged
}
${job}\n${harness}`);
const binary = join(dir, 'tests');
const compile = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
  '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos26.0`,
  '-module-cache-path', join(dir, 'module-cache'), path, '-o', binary], { encoding: 'utf8' });
if (compile.status !== 0) { process.stderr.write(compile.stderr); process.exit(compile.status || 1); }
const run = spawnSync(binary, { encoding: 'utf8', timeout: 20_000 });
process.stdout.write(run.stdout || '');
process.stderr.write(run.stderr || '');
if (run.error) console.error(run.error);
process.exit(run.status ?? 1);
