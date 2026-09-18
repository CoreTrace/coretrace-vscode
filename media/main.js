(function () {
    const vscode = acquireVsCodeApi();

    // ── DOM refs ───────────────────────────────────────────────────────────────
    const runBtn = document.getElementById('run-btn');
    const runLabel = document.getElementById('run-label');
    const resultsContainer = document.getElementById('results-container');
    const vulnList = document.getElementById('vuln-list');
    const vulnCount = document.getElementById('vuln-count');
    const findingsSearch = document.getElementById('findings-search');
    const severityFilter = document.getElementById('severity-filter');
    const findingsEmpty = document.getElementById('findings-empty');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    const statusDetail = document.getElementById('status-detail');
    const progressTrack = document.getElementById('progress-track');
    const progressBar = document.getElementById('progress-bar');
    const summaryErrors = document.getElementById('summary-errors');
    const summaryWarnings = document.getElementById('summary-warnings');
    const summaryNotes = document.getElementById('summary-notes');
    const helpBtn = document.getElementById('help-btn');
    const emptyState = document.getElementById('empty-state');
    const emptyRunBtn = document.getElementById('empty-run-btn');
    const fileLabel = document.getElementById('file-label');
    const scanModeRow = document.getElementById('scan-mode-row');
    const scanFileBtn = document.getElementById('scan-file-btn');
    const scanWorkspaceBtn = document.getElementById('scan-workspace-btn');
    const filePill = document.getElementById('file-pill');
    const sidebar = document.querySelector('.sidebar');
    const dashboardView = document.getElementById('dashboard-view');
    const settingsView = document.getElementById('settings-view');
    const settingsBtn = document.getElementById('settings-btn');
    const backBtn = document.getElementById('back-btn');
    const browseCompileCommands = document.getElementById('browse-compile-commands');
    const staticToolsBtn = document.getElementById('static-tools-btn');
    const dynamicToolsBtn = document.getElementById('dynamic-tools-btn');
    const staticToolsMenu = document.getElementById('static-tools-menu');
    const dynamicToolsMenu = document.getElementById('dynamic-tools-menu');
    const onlyDirGroup = document.getElementById('only-dir-group');
    const excludeDirGroup = document.getElementById('exclude-dir-group');
    const crossTuGroup = document.getElementById('cross-tu-group');
    const crossTuCb = document.getElementById('resource-cross-tu');
    const autoEntryGroup = document.getElementById('auto-entry-points-group');
    const autoEntryCb = document.getElementById('auto-entry-points');
    const autoEntryHint = document.getElementById('auto-entry-points-hint');
    const smtSection = document.getElementById('smt-section');
    const profileToggle = document.getElementById('analysis-profile-toggle');
    const profileLabel = document.getElementById('analysis-profile-label');
    const ikosCb = document.querySelector('.static-tool[value="ikos"]');
    const persistedState = vscode.getState() || {};
    let analysisProfile = 'full';
    let findings = [];
    let currentStatus = 'ready';
    let isRunning = false;
    let isDownloading = false;

    // ── Init Lucide icons ──────────────────────────────────────────────────────
    // Render static Lucide icons before wiring interactive controls.
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }

    function setView(view) {
        const settingsOpen = view === 'settings';
        if (sidebar) { sidebar.classList.toggle('settings-open', settingsOpen); }
        if (dashboardView) { dashboardView.classList.toggle('active', !settingsOpen); }
        if (settingsView) {
            settingsView.classList.toggle('active', settingsOpen);
            settingsView.setAttribute('aria-hidden', String(!settingsOpen));
        }
    }

    if (settingsBtn) { settingsBtn.addEventListener('click', () => setView('settings')); }
    if (backBtn) { backBtn.addEventListener('click', () => setView('dashboard')); }

    // ── Scan-all toggle ────────────────────────────────────────────────────────
    let lastFileName = '';

    let scanWorkspace = false;
    const closeTimeouts = new WeakMap();

    function setToolMenu(button, menu, open) {
        if (!button || !menu) { return; }

        const existingTimer = closeTimeouts.get(menu);
        if (existingTimer) {
            clearTimeout(existingTimer);
            closeTimeouts.delete(menu);
        }

        if (open) {
            menu.classList.remove('is-closing');
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
        } else {
            if (menu.hidden) {
                button.setAttribute('aria-expanded', 'false');
                return;
            }
            button.setAttribute('aria-expanded', 'false');
            menu.classList.add('is-closing');
            const timer = setTimeout(() => {
                menu.hidden = true;
                menu.classList.remove('is-closing');
                closeTimeouts.delete(menu);
            }, 160);
            closeTimeouts.set(menu, timer);
        }
    }

    function toggleToolMenu(button, menu) {
        const isCurrentlyOpen = !menu.hidden && !menu.classList.contains('is-closing');
        const willOpen = !isCurrentlyOpen;
        if (willOpen) {
            // Only allow one dropdown open at a time
            if (menu === staticToolsMenu) {
                setToolMenu(dynamicToolsBtn, dynamicToolsMenu, false);
            } else if (menu === dynamicToolsMenu) {
                setToolMenu(staticToolsBtn, staticToolsMenu, false);
            }
        }
        setToolMenu(button, menu, willOpen);
    }

    if (staticToolsBtn) { staticToolsBtn.addEventListener('click', () => toggleToolMenu(staticToolsBtn, staticToolsMenu)); }
    if (dynamicToolsBtn) { dynamicToolsBtn.addEventListener('click', () => toggleToolMenu(dynamicToolsBtn, dynamicToolsMenu)); }
    document.addEventListener('click', event => {
        if (!event.target.closest('.analysis-mode-menu')) {
            setToolMenu(staticToolsBtn, staticToolsMenu, false);
            setToolMenu(dynamicToolsBtn, dynamicToolsMenu, false);
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            setToolMenu(staticToolsBtn, staticToolsMenu, false);
            setToolMenu(dynamicToolsBtn, dynamicToolsMenu, false);
        }
    });

    function updateAnalysisModeStyles() {
        [staticToolsBtn, dynamicToolsBtn].forEach(button => {
            if (!button) { return; }
            const menu = button.nextElementSibling;
            const selected = menu ? menu.querySelectorAll('input:checked').length : 0;
            button.classList.toggle('active', selected > 0);
            button.classList.toggle('inactive', selected === 0);
        });
    }

    document.querySelectorAll('.static-tool, .dynamic-tool').forEach(control => {
        control.addEventListener('change', updateAnalysisModeStyles);
    });
    updateAnalysisModeStyles();

    function setScanMode(workspace) {
        const modeChanged = scanWorkspace !== workspace;
        scanWorkspace = workspace;
        if (scanModeRow) { scanModeRow.classList.toggle('workspace-active', workspace); }
        if (scanFileBtn) { scanFileBtn.classList.toggle('active', !workspace); }
        if (scanWorkspaceBtn) { scanWorkspaceBtn.classList.toggle('active', workspace); }
        if (filePill) {
            filePill.classList.remove('faded');
            if (modeChanged) {
                filePill.classList.remove('slide-left', 'slide-right');
                void filePill.offsetWidth;
                filePill.classList.add(workspace ? 'slide-right' : 'slide-left');
            }
        }
        if (fileLabel) {
            fileLabel.textContent = workspace
                ? 'All C/C++ files in workspace'
                : (lastFileName || 'Open a C/C++ file to analyse');
        }
        [onlyDirGroup, excludeDirGroup].forEach(group => {
            if (group) { group.classList.toggle('is-hidden', !workspace); }
        });
        if (crossTuCb) {
            crossTuCb.disabled = !workspace;
            if (!workspace) { crossTuCb.checked = false; }
        }
        if (crossTuGroup) { crossTuGroup.classList.toggle('is-disabled', !workspace); }
        if (autoEntryCb) { autoEntryCb.disabled = workspace; }
        if (autoEntryGroup) { autoEntryGroup.classList.toggle('is-disabled', workspace); }
        if (autoEntryHint) { autoEntryHint.hidden = !workspace; }
        saveUiState();
    }

    if (scanFileBtn) { scanFileBtn.addEventListener('click', () => setScanMode(false)); }
    if (scanWorkspaceBtn) { scanWorkspaceBtn.addEventListener('click', () => setScanMode(true)); }
    setScanMode(false);

    if (scanModeRow) {
        scanModeRow.addEventListener('keydown', event => {
            if (event.key === 'ArrowLeft') { setScanMode(false); }
            if (event.key === 'ArrowRight') { setScanMode(true); }
        });
    }

    // ── CLI help ──────────────────────────────────────────────────────────────
    if (helpBtn) {
        helpBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'execute-command', command: 'ctrace.showHelp' });
        });
    }

    if (browseCompileCommands) {
        browseCompileCommands.addEventListener('click', () => {
            vscode.postMessage({ type: 'pick-compile-commands' });
        });
    }

    if (findingsSearch) { findingsSearch.addEventListener('input', renderFilteredFindings); }
    if (severityFilter) { severityFilter.addEventListener('change', renderFilteredFindings); }

    const smtEnabled = document.getElementById('smt-enabled');
    const smtControls = ['smt-backend', 'smt-secondary-backend', 'smt-mode', 'smt-timeout-ms', 'smt-rules']
        .map(id => document.getElementById(id))
        .filter(Boolean);

    function updateSmtControls() {
        const enabled = Boolean(smtEnabled && smtEnabled.checked);
        smtControls.forEach(control => { control.disabled = !enabled; });
    }

    if (smtEnabled) {
        smtEnabled.addEventListener('change', updateSmtControls);
        updateSmtControls();
    }

    function updateProfileDependentUi() {
        const fast = analysisProfile === 'fast';
        if (fast && smtEnabled) {
            smtEnabled.checked = false;
            updateSmtControls();
        }
        if (smtSection) {
            smtSection.classList.toggle('is-disabled', fast);
            smtSection.style.display = fast ? 'none' : '';
        }
        if (ikosCb) {
            ikosCb.disabled = Boolean(fast);
            if (fast) { ikosCb.checked = false; }
        }
        if (ikosCb) { ikosCb.disabled = Boolean(fast); }
    }

    function setAnalysisProfile(profile) {
        analysisProfile = profile === 'fast' ? 'fast' : 'full';
        const label = analysisProfile === 'fast' ? 'Fast' : 'Full';
        if (profileLabel) { profileLabel.textContent = label; }
        if (profileToggle) {
            profileToggle.setAttribute('aria-label', `Analysis profile: ${label}`);
        }
        updateProfileDependentUi();
    }

    if (profileToggle) {
        profileToggle.addEventListener('click', () => {
            setAnalysisProfile(analysisProfile === 'full' ? 'fast' : 'full');
            saveUiState();
        });
    }
    setAnalysisProfile('full');

    function restoreUiState() {
        const saved = persistedState.uiState;
        if (!saved) { return; }

        setScanMode(persistedState.scanWorkspace === true);
        setAnalysisProfile(saved.analysisProfile || 'full');
        restoreToolSelection('.static-tool', saved.staticTools, saved.staticEnabled !== false);
        restoreToolSelection('.dynamic-tool', saved.dynamicTools, saved.dynamicEnabled !== false);
        setValue('only-function', saved.onlyFunction || '');
        setValue('only-dir', saved.onlyDir || '');
        setValue('exclude-dir', saved.excludeDir || '');
        setChecked('include-stl', saved.includeStl === true);
        setChecked('resource-cross-tu', saved.resourceCrossTu === true);
        setChecked('auto-entry-points', saved.autoEntryPoints === true);
        setChecked('smt-enabled', saved.smtEnabled === true);
        setValue('smt-backend', saved.smtBackend || 'interval');
        setValue('smt-secondary-backend', saved.smtSecondaryBackend || 'interval');
        setValue('smt-mode', saved.smtMode || 'single');
        setValue('smt-timeout-ms', saved.smtTimeoutMs || '');
        setValue('smt-rules', saved.smtRules || '');
        setChecked('compdb-fast', saved.compdbFast === true);
        setChecked('include-compdb-deps', saved.includeCompdbDeps === true);
        setValue('compiler-extra-args', saved.compilerExtraArgs || '');
        setValue('extra-includes', saved.extraIncludes || '');
        setValue('macros', saved.macros || '');
        setChecked('quiet', saved.quiet === true);
        setChecked('warnings-only', saved.warningsOnly === true);
        setChecked('timing', saved.timing === true);
        setChecked('demangle', saved.demangle === true);
        setChecked('dump-filter', saved.dumpFilter === true);

        updateAnalysisModeStyles();
        updateSmtControls();
        updateProfileDependentUi();
    }

    function saveUiState() {
        vscode.setState({
            uiState: readCtraceUiState(),
            scanWorkspace,
        });
    }

    function bindStatePersistence() {
        document.querySelectorAll('input, select').forEach(control => {
            control.addEventListener('input', saveUiState);
            control.addEventListener('change', saveUiState);
        });
    }

    restoreUiState();
    bindStatePersistence();

    // ── Run button ─────────────────────────────────────────────────────────────
    if (runBtn) {
        runBtn.addEventListener('click', () => {
            const uiState = readCtraceUiState();

            setRunning(true);

            vscode.postMessage({
                type: 'execute-command',
                command: 'ctrace.runAnalysis',
                params: { uiState, scanWorkspace, scanMode: scanWorkspace ? 'workspace' : 'file' }
            });
        });
    }

    if (emptyRunBtn && runBtn) {
        emptyRunBtn.addEventListener('click', () => runBtn.click());
    }

    function readCtraceUiState() {
        return {
            scanMode: scanWorkspace ? 'workspace' : 'file',
            staticTools: selectedTools('.static-tool'),
            dynamicTools: selectedTools('.dynamic-tool'),
            staticEnabled: selectedTools('.static-tool').length > 0,
            dynamicEnabled: selectedTools('.dynamic-tool').length > 0,
            onlyFunction: valueOf('only-function'),
            onlyDir: valueOf('only-dir'),
            excludeDir: valueOf('exclude-dir'),
            includeStl: checked('include-stl'),
            resourceCrossTu: scanWorkspace && checked('resource-cross-tu'),
            autoEntryPoints: !scanWorkspace && checked('auto-entry-points'),
            smtEnabled: checked('smt-enabled'),
            smtBackend: valueOf('smt-backend') || 'interval',
            smtSecondaryBackend: valueOf('smt-secondary-backend') || 'interval',
            smtMode: valueOf('smt-mode') || 'single',
            smtTimeoutMs: numberValueOf('smt-timeout-ms'),
            smtRules: valueOf('smt-rules'),
            analysisProfile,
            invokedTools: [],
            compileCommandsPath: valueOf('compile-commands-path'),
            compdbFast: checked('compdb-fast'),
            includeCompdbDeps: checked('include-compdb-deps'),
            compilerExtraArgs: valueOf('compiler-extra-args'),
            extraIncludes: valueOf('extra-includes'),
            macros: valueOf('macros'),
            quiet: checked('quiet'),
            warningsOnly: checked('warnings-only'),
            timing: checked('timing'),
            demangle: checked('demangle'),
            dumpFilter: checked('dump-filter'),
        };
    }

    function selectedInvokeTools() {
        return Array.from(document.querySelectorAll('.static-tool:checked, .dynamic-tool:checked'))
            .map(element => element.value);
    }

    function selectedTools(selector) {
        return Array.from(document.querySelectorAll(`${selector}:checked`)).map(element => element.value);
    }

    function restoreToolSelection(selector, savedTools, enabled) {
        const selected = Array.isArray(savedTools) ? savedTools : null;
        document.querySelectorAll(selector).forEach(tool => {
            tool.checked = selected ? selected.includes(tool.value) : enabled;
        });
    }

    function checked(id) {
        const element = document.getElementById(id);
        return Boolean(element && element.checked);
    }

    function valueOf(id) {
        const element = document.getElementById(id);
        return element ? element.value.trim() : '';
    }

    function numberValueOf(id) {
        const value = valueOf(id);
        return value ? Number(value) : undefined;
    }

    function setValue(id, value) {
        const element = document.getElementById(id);
        if (element) { element.value = value; }
    }

    function setChecked(id, value) {
        const element = document.getElementById(id);
        if (element) { element.checked = value; }
    }

    // ── Incoming messages ──────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'analysis-downloading':
                setDownloading(msg.progress);
                break;
            case 'analysis-download-complete':
                setDownloadComplete();
                break;
            case 'analysis-start':
                setRunning(true);
                break;
            case 'analysis-result':
                handleAnalysisResult(msg.data);
                break;
            case 'analysis-done':
                setRunning(false);
                if (currentStatus === 'running') { setStatus('Ready to audit', '', 'ready'); }
                break;
            case 'analysis-error':
                setRunning(false);
                setStatus(msg.message || 'Analysis failed', msg.detail || '', 'error');
                break;
            case 'analysis-progress':
                setStatus(msg.message || 'Analysing…', msg.detail || '', 'running');
                setProgress(msg.percent);
                break;
            case 'analysis-status':
                setStatus(msg.message || 'Analysis complete', msg.detail || '', msg.status || 'ready');
                break;
            case 'active-file':
                lastFileName = msg.name || 'No file open';
                if (fileLabel && !scanWorkspace) {
                    fileLabel.textContent = lastFileName;
                }
                break;
            case 'compile-commands-selected':
                setValue('compile-commands-path', msg.path || '');
                break;
        }
    });

    function setValue(id, value) {
        const element = document.getElementById(id);
        if (element) { element.value = value; }
    }

    // ── Handlers ───────────────────────────────────────────────────────────────
    function setDownloading(progressMsg) {
        isDownloading = true;
        if (!runBtn) { return; }
        runBtn.disabled = true;
        runBtn.classList.add('running'); // Force spinner instead of play icon
        if (runLabel) { runLabel.textContent = `Downloading (${progressMsg})`; }
        
        if (scanFileBtn) {
            scanFileBtn.style.opacity = '0.5';
            scanFileBtn.style.cursor = 'not-allowed';
        }
        if (scanWorkspaceBtn) {
            scanWorkspaceBtn.style.opacity = '0.5';
            scanWorkspaceBtn.style.cursor = 'not-allowed';
        }
    }

    function setDownloadComplete() {
        isDownloading = false;
        if (!isRunning) {
            setRunning(false);
        }
    }

    function setRunning(running) {
        isRunning = running;
        if (running) {
            isDownloading = false;
        }
        if (!runBtn) { return; }
        runBtn.disabled = running;
        runBtn.classList.toggle('running', running);
        if (runLabel) { runLabel.textContent = running ? 'Analysing…' : 'Run Analysis'; }
        if (running) {
            setStatus('Analysis in progress', 'Ctrace is scanning the selected scope', 'running');
            setProgress(0);
        }
        // Icons are toggled purely by CSS (.running .icon-idle / .icon-running)
        // No lucide.createIcons() call needed — avoids invalidating other SVG refs.
        
        if (scanFileBtn) {
            scanFileBtn.style.opacity = running ? '0.5' : '1';
            scanFileBtn.style.cursor = running ? 'not-allowed' : 'pointer';
        }
        if (scanWorkspaceBtn) {
            scanWorkspaceBtn.style.opacity = running ? '0.5' : '1';
            scanWorkspaceBtn.style.cursor = running ? 'not-allowed' : 'pointer';
        }
    }

    function setWsProgress(total, changed, cached, done) {
        if (!wsProgressBar || !wsProgressText) { return; }
        const pct = changed > 0 ? Math.round((done / changed) * 100) : 0;
        wsProgressBar.style.width = pct + '%';
        if (cached > 0) {
            wsProgressText.textContent = `${done}/${changed} analysed · ${cached} cached`;
        } else {
            wsProgressText.textContent = `${done}/${changed} files`;
        }
    }

    function handleAnalysisResult(sarif) {
        setRunning(false);
        setStatus('Analysis complete', 'Findings are shown below', 'success');
        setProgress(100);

        if (emptyState) { emptyState.style.display = 'none'; }
        if (resultsContainer) { resultsContainer.classList.remove('results-hidden'); }
        if (vulnList) { vulnList.innerHTML = ''; }

        findings = [];

        if (sarif && sarif.runs) {
            sarif.runs.forEach(run => {
                (run.results || []).forEach(res => findings.push(res));
            });
        }

        const count = findings.length;
        if (vulnCount) {
            vulnCount.textContent = String(count);
            vulnCount.classList.toggle('zero', count === 0);
        }

        updateSummary(findings);
        renderFilteredFindings();

        if (count === 0 && vulnList) {
            vulnList.innerHTML = '<li class="info-item">No issues detected for the selected scope.</li>';
            if (typeof lucide !== 'undefined') { lucide.createIcons(); }
        }
    }

    function renderFilteredFindings() {
        if (!vulnList) { return; }
        const query = findingsSearch ? findingsSearch.value.trim().toLowerCase() : '';
        const severity = severityFilter ? severityFilter.value : 'all';
        const filtered = findings.filter(result => {
            const level = (result.level || 'warning').toLowerCase();
            const text = `${result.ruleId || ''} ${result.message?.text || ''} ${result.locations?.[0]?.physicalLocation?.artifactLocation?.uri || ''}`.toLowerCase();
            return (severity === 'all' || level === severity) && (!query || text.includes(query));
        });

        vulnList.innerHTML = '';
        filtered.forEach(addVulnItem);
        if (findingsEmpty) { findingsEmpty.hidden = findings.length === 0 || filtered.length > 0; }
        if (findings.length > 0 && filtered.length === 0 && vulnList) {
            vulnList.innerHTML = '<li class="info-item">No findings match the current filters.</li>';
        }
    }

    function updateSummary(results) {
        const counts = { error: 0, warning: 0, note: 0 };
        results.forEach(result => {
            const level = (result.level || 'warning').toLowerCase();
            if (counts[level] !== undefined) { counts[level]++; }
        });
        if (summaryErrors) { summaryErrors.textContent = String(counts.error); }
        if (summaryWarnings) { summaryWarnings.textContent = String(counts.warning); }
        if (summaryNotes) { summaryNotes.textContent = String(counts.note); }
    }

    function setStatus(message, detail, state) {
        currentStatus = state || 'ready';
        if (statusText) { statusText.textContent = message; }
        if (statusDetail) { statusDetail.textContent = detail; }
        if (statusDot) {
            statusDot.className = `status-dot ${state || 'ready'}`;
        }
    }

    function setProgress(percent) {
        if (!progressTrack || !progressBar) { return; }
        progressTrack.hidden = percent === undefined || percent === null || percent >= 100;
        if (percent !== undefined && percent !== null) {
            progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        }
    }

    function addVulnItem(res) {
        if (!vulnList) { return; }

        const level = (res.level || 'warning').toLowerCase();
        const ruleId = res.ruleId || 'Rule';
        const message = res.message ? res.message.text : 'Unknown issue';
        const loc = res.locations && res.locations[0];

        let locText = '';
        let line = 0;
        let filePath = '';

        if (loc && loc.physicalLocation) {
            const pl = loc.physicalLocation;
            if (pl.artifactLocation && pl.artifactLocation.uri) {
                const parts = pl.artifactLocation.uri.split('/');
                locText = parts[parts.length - 1];
                filePath = pl.artifactLocation.uri;
            }
            if (pl.region) {
                line = pl.region.startLine || 0;
                locText += `:${line}`;
            }
        }

        const sevClass = level === 'error' ? 'sev-error' : level === 'note' ? 'sev-note' : 'sev-warning';
        const sevIcon = level === 'error' ? 'x-circle' : level === 'note' ? 'info' : 'triangle-alert';
        const ruleIcon = level === 'error' ? 'shield-alert' : level === 'note' ? 'info' : 'triangle-alert';

        const li = document.createElement('li');
        li.className = `vuln-item vuln-item-${level}`;
        li.innerHTML = `
            <div class="vuln-header">
                <span class="vuln-rule">
                    <i data-lucide="${ruleIcon}"></i>
                    ${escapeHtml(ruleId)}
                </span>
                <span class="vuln-sev ${sevClass}">
                    <i data-lucide="${sevIcon}"></i>
                    ${escapeHtml(level)}
                </span>
            </div>
            ${locText ? `<div class="vuln-loc"><i data-lucide="map-pin"></i>${escapeHtml(locText)}</div>` : ''}
            <div class="vuln-msg">${escapeHtml(message)}</div>
        `;

        li.addEventListener('click', () => {
            const safeLine = (typeof line === 'number' && isFinite(line)) ? Math.max(0, line - 1) : 0;
            vscode.postMessage({ type: 'open-file', path: filePath, line: safeLine });
        });

        vulnList.appendChild(li);

        // Scope createIcons to the new item only
        if (typeof lucide !== 'undefined') { lucide.createIcons({ nodes: [li] }); }
    }

    function escapeHtml(str) {
        if (!str) { return ''; }
        return str
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    // Notify the extension host that the webview is ready and query initial binary/analysis status
    try {
        vscode.postMessage({ type: 'webview-ready' });
    } catch {
        // Ignore if posting message is not permitted yet
    }

}());

