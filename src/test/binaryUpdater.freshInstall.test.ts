import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import * as vscode from 'vscode';
import { ensureBinary, getAssetForPlatform, getLastBinaryProblem, setFetchForTesting } from '../ctrace/BinaryUpdater';

suite('BinaryUpdater fresh install Test Suite', function () {
    this.timeout(30000);
    let work = '';
    let savedPath: string | undefined;
    let calls: string[] = [];

    const osToken = process.platform === 'darwin' ? 'macos' : 'linux';
    const archToken = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const assetName = `coretrace-v9.9.9-${osToken}-${archToken}.tar.gz`;

    function fakeContext(): vscode.ExtensionContext {
        const values = new Map<string, unknown>();
        return {
            extensionUri: vscode.Uri.file(path.join(work, 'extension')),
            globalStorageUri: vscode.Uri.file(path.join(work, 'storage')),
            globalState: {
                get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
                update: async (key: string, value: unknown) => { values.set(key, value); },
                keys: () => [...values.keys()],
            },
        } as unknown as vscode.ExtensionContext;
    }
    const output = { appendLine: () => { /* quiet */ } } as unknown as vscode.OutputChannel;

    /** A release archive like the real ones: one top-level folder holding bin/ctrace. */
    function releaseArchive(): Buffer {
        const root = path.join(work, 'release-src');
        fs.mkdirSync(path.join(root, 'coretrace-v9.9.9', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(root, 'coretrace-v9.9.9', 'bin', 'ctrace'), '#!/bin/sh\necho 9.9.9\n', { mode: 0o755 });
        const archive = path.join(work, 'release.tar.gz');
        tar.c({ gzip: true, cwd: root, sync: true, file: archive }, ['coretrace-v9.9.9']);
        return fs.readFileSync(archive);
    }

    function serve(answers: ((url: string) => Response)[]): void {
        calls = [];
        setFetchForTesting((async (input: string | URL | Request) => {
            const url = String(input);
            calls.push(url);
            const answer = answers.shift();
            if (!answer) { throw new Error(`unexpected request to ${url}`); }
            return answer(url);
        }) as typeof fetch);
    }

    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

    setup(() => {
        work = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrace-fresh-'));
        fs.mkdirSync(path.join(work, 'extension'));
        // No ctrace on PATH: a fresh install.
        savedPath = process.env.PATH;
        process.env.PATH = path.join(work, 'empty-path');
    });

    teardown(() => {
        process.env.PATH = savedPath;
        setFetchForTesting(undefined);
        fs.rmSync(work, { recursive: true, force: true });
    });

    test('a 403 from GitHub is explained, then a retry installs the CLI', async function () {
        if (!getAssetForPlatform([{ name: assetName, browser_download_url: 'u' }])) { this.skip(); }
        const context = fakeContext();
        const reset = Math.floor(Date.now() / 1000) + 600;
        serve([() => json(403, { message: 'API rate limit exceeded for 203.0.113.7.' },
            { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })]);

        assert.strictEqual(await ensureBinary(context, output), null);
        const problem = getLastBinaryProblem();
        assert.strictEqual(problem?.kind, 'release-lookup');
        assert.match(problem!.message, /HTTP 403/);
        assert.match(problem!.message, /API rate limit exceeded/);
        assert.match(problem!.message, /used up until/);

        // Within the backoff, a plain call does not hit GitHub again and keeps the reason.
        serve([]);
        assert.strictEqual(await ensureBinary(context, output), null);
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(getLastBinaryProblem()?.kind, 'release-lookup');

        // Retry: forced past the backoff, GitHub now answers.
        const archive = releaseArchive();
        serve([
            () => json(200, { tag_name: 'v9.9.9', assets: [{ name: assetName, browser_download_url: 'https://example.test/release.tar.gz' }] }),
            () => new Response(new Uint8Array(archive), { status: 200, headers: { 'content-length': String(archive.length) } }),
        ]);
        const binary = await ensureBinary(context, output, { force: true });
        assert.ok(binary && fs.existsSync(binary), `no binary installed: ${binary}`);
        assert.strictEqual(getLastBinaryProblem(), undefined);
        assert.strictEqual(context.globalState.get('coretrace-version'), 'v9.9.9');
        assert.deepStrictEqual(calls, ['https://api.github.com/repos/CoreTrace/coretrace/releases/latest', 'https://example.test/release.tar.gz']);
    });

    test('a release without a file for this platform is told apart from a failed lookup', async () => {
        serve([() => json(200, { tag_name: 'v9.9.9', assets: [{ name: 'coretrace-v9.9.9-plan9-mips.tar.gz', browser_download_url: 'u' }] })]);
        assert.strictEqual(await ensureBinary(fakeContext(), output), null);
        assert.strictEqual(getLastBinaryProblem()?.kind, 'no-asset');
        assert.match(getLastBinaryProblem()!.message, /no prebuilt binary/);
    });

    test('a network error is a failed lookup too', async () => {
        serve([() => { throw new TypeError('fetch failed'); }]);
        assert.strictEqual(await ensureBinary(fakeContext(), output), null);
        assert.strictEqual(getLastBinaryProblem()?.kind, 'release-lookup');
        assert.match(getLastBinaryProblem()!.message, /could not be reached.*fetch failed/);
    });
});
