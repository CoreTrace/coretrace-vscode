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
    const tabFindingsBtn = document.getElementById('tab-findings-btn');
    const tabStackBtn = document.getElementById('tab-stack-btn');
    const panelFindings = document.getElementById('panel-findings');
    const panelStack = document.getElementById('panel-stack');
    const tabVulnBadge = document.getElementById('tab-vuln-badge');
    const tabStackBadge = document.getElementById('tab-stack-badge');
    const stackPeakVal = document.getElementById('stack-peak-val');
    const stackRecursionVal = document.getElementById('stack-recursion-val');
    const stackFunctionsVal = document.getElementById('stack-functions-val');
    const stackGraphContainer = document.getElementById('stack-graph-container');
    const stackGraphInspector = document.getElementById('stack-graph-inspector');
    const stackGraphCount = document.getElementById('stack-graph-count');
    const stackZoomOut = document.getElementById('stack-zoom-out');
    const stackZoomIn = document.getElementById('stack-zoom-in');
    const stackZoomLabel = document.getElementById('stack-zoom-label');
    const stackFnList = document.getElementById('stack-fn-list');
    const stackSearch = document.getElementById('stack-search');
    let currentStackReport = null;
    let graphSelectedId = null;
    let graphZoom = 0.85;
    let graphPan = null;
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

    const installDepsBtn = document.getElementById('install-deps-btn');
    if (installDepsBtn) {
        installDepsBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'execute-command', command: 'ctrace.installDependencies' });
        });
    }

    if (browseCompileCommands) {
        browseCompileCommands.addEventListener('click', () => {
            vscode.postMessage({ type: 'pick-compile-commands' });
        });
    }

    if (findingsSearch) { findingsSearch.addEventListener('input', renderFilteredFindings); }
    if (severityFilter) { severityFilter.addEventListener('change', renderFilteredFindings); }
    if (tabFindingsBtn) { tabFindingsBtn.addEventListener('click', () => switchResultTab('findings')); }
    if (tabStackBtn) { tabStackBtn.addEventListener('click', () => switchResultTab('stack')); }
    if (stackSearch) { stackSearch.addEventListener('input', renderFilteredStackFunctions); }
    if (stackZoomOut) { stackZoomOut.addEventListener('click', () => { graphZoom = Math.max(0.65, Math.round((graphZoom - 0.1) * 100) / 100); applyGraphZoom(); }); }
    if (stackZoomIn) { stackZoomIn.addEventListener('click', () => { graphZoom = Math.min(1.5, Math.round((graphZoom + 0.1) * 100) / 100); applyGraphZoom(); }); }
    if (stackGraphContainer) {
        stackGraphContainer.addEventListener('pointerdown', event => {
            if (event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('.stack-graph-node')) { return; }
            graphPan = { x: event.clientX, y: event.clientY,
                left: stackGraphContainer.scrollLeft, top: stackGraphContainer.scrollTop };
            stackGraphContainer.setPointerCapture(event.pointerId);
            stackGraphContainer.classList.add('is-panning');
        });
        stackGraphContainer.addEventListener('pointermove', event => {
            if (!graphPan) { return; }
            stackGraphContainer.scrollLeft = graphPan.left - (event.clientX - graphPan.x);
            stackGraphContainer.scrollTop = graphPan.top - (event.clientY - graphPan.y);
        });
        const stopGraphPan = () => { graphPan = null; stackGraphContainer.classList.remove('is-panning'); };
        stackGraphContainer.addEventListener('pointerup', stopGraphPan);
        stackGraphContainer.addEventListener('pointercancel', stopGraphPan);
    }

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
                handleAnalysisResult(msg.data, msg.restored === true, msg.savedAt);
                break;
            case 'clear-results':
                clearDisplayedResults();
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
            case 'stack-data':
                handleStackData(msg.data);
                break;
            case 'focus-stack-tab':
                switchResultTab('stack');
                if (msg.functionName) {
                    highlightStackFunction(msg.functionName);
                }
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

    function handleAnalysisResult(sarif, restored = false, savedAt) {
        setRunning(false);
        const savedLabel = Number.isFinite(savedAt) ? new Date(savedAt).toLocaleString() : 'Saved results';
        setStatus(restored ? 'Last analysis' : 'Analysis complete', restored ? savedLabel : 'Findings are shown below', 'success');
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

        if (tabVulnBadge) {
            tabVulnBadge.textContent = String(count);
        }
    }

    function clearDisplayedResults() {
        findings = [];
        currentStackReport = null;
        graphSelectedId = null;
        if (vulnList) { vulnList.replaceChildren(); }
        if (stackFnList) { stackFnList.replaceChildren(); }
        if (stackGraphContainer) {
            stackGraphContainer.innerHTML = '<div class="stack-empty-hint">Run the stack analyzer to view functions and calls.</div>';
        }
        if (stackGraphInspector) { stackGraphInspector.hidden = true; }
        if (stackGraphCount) { stackGraphCount.textContent = '0 functions · 0 calls'; }
        if (vulnCount) { vulnCount.textContent = '0'; vulnCount.classList.add('zero'); }
        if (tabVulnBadge) { tabVulnBadge.textContent = '0'; }
        if (tabStackBadge) { tabStackBadge.textContent = '0'; }
        if (stackPeakVal) { stackPeakVal.textContent = '0 B'; }
        if (stackRecursionVal) { stackRecursionVal.textContent = '0'; stackRecursionVal.className = 'stack-metric-val'; }
        if (stackFunctionsVal) { stackFunctionsVal.textContent = '0'; }
        updateSummary([]);
        if (resultsContainer) { resultsContainer.classList.add('results-hidden'); }
        if (emptyState) { emptyState.style.display = ''; }
        switchResultTab('findings');
        setProgress(undefined);
        setStatus('Ready to audit', '', 'ready');
    }

    function switchResultTab(tabName) {
        const isFindings = tabName === 'findings';
        if (tabFindingsBtn) {
            tabFindingsBtn.classList.toggle('active', isFindings);
            tabFindingsBtn.setAttribute('aria-selected', isFindings ? 'true' : 'false');
        }
        if (tabStackBtn) {
            tabStackBtn.classList.toggle('active', !isFindings);
            tabStackBtn.setAttribute('aria-selected', !isFindings ? 'true' : 'false');
        }
        if (panelFindings) { panelFindings.hidden = !isFindings; }
        if (panelStack) { panelStack.hidden = isFindings; }

        if (!isFindings && typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) { return '0 B'; }
        if (bytes < 1024) { return `${bytes} B`; }
        if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function handleStackData(report) {
        if (!report) { return; }
        currentStackReport = report;
        graphSelectedId = null;

        if (emptyState) { emptyState.style.display = 'none'; }
        if (resultsContainer) { resultsContainer.classList.remove('results-hidden'); }

        const fnCount = (report.functions || []).length;
        if (tabStackBadge) {
            tabStackBadge.textContent = String(fnCount);
        }

        if (stackPeakVal) {
            stackPeakVal.textContent = formatBytes(report.peakStack);
        }

        if (stackRecursionVal) {
            const hasRec = (report.recursiveCount || 0) > 0;
            stackRecursionVal.textContent = hasRec ? `${report.recursiveCount} Cycle${report.recursiveCount > 1 ? 's' : ''}` : '0 (Safe)';
            stackRecursionVal.className = `stack-metric-val ${hasRec ? 'metric-danger' : 'metric-safe'}`;
        }

        if (stackFunctionsVal) {
            stackFunctionsVal.textContent = String(fnCount);
        }

        renderCallGraph(report);
        renderFilteredStackFunctions();
    }

    function renderCallGraph(report) {
        if (!stackGraphContainer) { return; }
        stackGraphContainer.replaceChildren();
        const nodes = report.callGraph?.nodes || [];
        const nodeById = new Map(nodes.map(node => [node.id, node]));
        const edges = (report.callGraph?.edges || []).filter(edge =>
            nodeById.has(edge.from) && nodeById.has(edge.to));
        if (stackGraphCount) {
            stackGraphCount.textContent = `${nodes.length} functions · ${edges.length} calls`;
        }
        if (!nodes.length) {
            stackGraphContainer.innerHTML = '<div class="stack-empty-hint">No function data available.</div>';
            if (stackGraphInspector) { stackGraphInspector.hidden = true; }
            return;
        }

        const depth = new Map(nodes.map(node => [node.id, 0]));
        const incoming = new Map(nodes.map(node => [node.id, 0]));
        const outgoing = new Map(nodes.map(node => [node.id, []]));
        edges.filter(edge => edge.from !== edge.to).forEach(edge => {
            incoming.set(edge.to, incoming.get(edge.to) + 1);
            outgoing.get(edge.from).push(edge.to);
        });
        const queue = nodes.filter(node => incoming.get(node.id) === 0)
            .sort((a, b) => (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name)))
            .map(node => node.id);
        const placed = new Set();
        while (queue.length) {
            const id = queue.shift();
            if (placed.has(id)) { continue; }
            placed.add(id);
            outgoing.get(id).forEach(target => {
                depth.set(target, Math.max(depth.get(target), Math.min(depth.get(id) + 1, 9)));
                incoming.set(target, incoming.get(target) - 1);
                if (incoming.get(target) === 0) { queue.push(target); }
            });
        }
        edges.filter(edge => placed.has(edge.from) && !placed.has(edge.to)).forEach(edge => {
            depth.set(edge.to, Math.min(depth.get(edge.from) + 1, 9));
        });

        const columns = new Map();
        nodes.forEach(node => {
            const level = depth.get(node.id);
            if (!columns.has(level)) { columns.set(level, []); }
            columns.get(level).push(node);
        });
        const levels = [...columns.keys()].sort((a, b) => a - b);
        levels.forEach(level => columns.get(level).sort((a, b) => {
            const parents = id => edges.filter(edge => edge.to === id).map(edge => edge.from);
            const rank = id => {
                const values = parents(id).map(parent => {
                    const parentColumn = columns.get(depth.get(parent)) || [];
                    return parentColumn.findIndex(node => node.id === parent);
                }).filter(value => value >= 0);
                return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 999;
            };
            return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
        }));

        const nodeWidth = 188;
        const nodeHeight = 78;
        const colStep = 280;
        const rowStep = 122;
        const maxRows = Math.max(...[...columns.values()].map(column => column.length));
        const width = 60 + (Math.max(...levels) * colStep) + nodeWidth + 40;
        const height = Math.max(250, 75 + maxRows * rowStep);
        const positions = new Map();
        columns.forEach((column, level) => column.forEach((node, row) => {
            positions.set(node.id, {
                x: 36 + level * colStep,
                y: 36 + (maxRows - column.length) * rowStep / 2 + row * rowStep
            });
        }));

        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.classList.add('stack-graph');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', `${nodes.length} functions connected by ${edges.length} calls`);
        svg.dataset.baseWidth = String(width);
        svg.dataset.baseHeight = String(height);
        const make = (tag, attrs, parent) => {
            const element = document.createElementNS(ns, tag);
            Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
            parent.appendChild(element);
            return element;
        };
        const defs = make('defs', {}, svg);
        const nodeGradient = make('linearGradient', { id: 'stack-node-gradient', x1: '0%', x2: '0%', y1: '0%', y2: '100%' }, defs);
        make('stop', { offset: '0%', class: 'stack-node-top' }, nodeGradient);
        make('stop', { offset: '100%', class: 'stack-node-bottom' }, nodeGradient);
        const gradient = make('linearGradient', { id: 'stack-wire-gradient', x1: '0%', x2: '100%' }, defs);
        make('stop', { offset: '0%', class: 'stack-wire-start' }, gradient);
        make('stop', { offset: '100%', class: 'stack-wire-end' }, gradient);
        const edgeLayer = make('g', { class: 'stack-graph-edges' }, svg);
        edges.forEach(edge => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            const self = edge.from === edge.to;
            const x1 = from.x + nodeWidth;
            const y1 = from.y + nodeHeight / 2;
            const x2 = to.x;
            const y2 = to.y + nodeHeight / 2;
            let d;
            if (self) {
                d = `M ${from.x + 118} ${from.y} C ${from.x + 118} ${from.y - 40}, ${from.x + 175} ${from.y - 40}, ${from.x + 175} ${from.y}`;
            } else if (x2 > x1) {
                const bend = Math.max(36, (x2 - x1) * 0.45);
                d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
            } else {
                const rail = height - 26;
                d = `M ${x1} ${y1} C ${x1 + 48} ${y1}, ${x1 + 48} ${rail}, ${x1} ${rail} L ${x2 - 35} ${rail} C ${x2 - 50} ${rail}, ${x2 - 50} ${y2}, ${x2} ${y2}`;
            }
            const wire = make('g', { class: 'stack-graph-wire' }, edgeLayer);
            wire.dataset.from = edge.from;
            wire.dataset.to = edge.to;
            if (edge.isRecursiveCycle || self) { wire.classList.add('recursive'); }
            make('path', { d, class: 'wire-glow' }, wire);
            make('path', { d, class: 'wire-line' }, wire);
            if (!self) { make('circle', { cx: x2, cy: y2, r: 3.4, class: 'wire-terminal' }, wire); }
        });
        const nodeLayer = make('g', { class: 'stack-graph-nodes' }, svg);
        const maxStack = Math.max(1, ...nodes.map(node => node.maxStack || 0));
        nodes.forEach(node => {
            const pos = positions.get(node.id);
            const group = make('g', {
                class: 'stack-graph-node', transform: `translate(${pos.x} ${pos.y})`,
                tabindex: 0, role: 'button',
                'aria-label': `${node.name}, local ${formatBytes(node.localStack)}, peak ${formatBytes(node.maxStack)}`
            }, nodeLayer);
            group.dataset.id = node.id;
            if (node.isRecursive || node.hasInfiniteSelfRecursion) { group.classList.add('recursive'); }
            if (node.exceedsLimit) { group.classList.add('over-limit'); }
            make('rect', { x: 0, y: 0, width: nodeWidth, height: nodeHeight, rx: 11, class: 'node-shell' }, group);
            make('rect', { x: 0, y: 14, width: 3, height: 50, rx: 1.5, class: 'node-accent' }, group);
            make('rect', { x: 12, y: 12, width: 26, height: 26, rx: 7, class: 'node-icon-box' }, group);
            const icon = make('text', { x: 25, y: 30, class: 'node-icon', 'text-anchor': 'middle' }, group);
            icon.textContent = 'ƒ';
            const title = make('text', { x: 47, y: 29, class: 'node-title' }, group);
            title.textContent = node.name.length > 20 ? `${node.name.slice(0, 18)}…` : node.name;
            const tooltip = make('title', {}, group);
            tooltip.textContent = node.name;
            const localLabel = make('text', { x: 13, y: 55, class: 'node-meta-label' }, group);
            localLabel.textContent = 'LOCAL';
            const localValue = make('text', { x: 55, y: 55, class: 'node-meta-value' }, group);
            localValue.textContent = formatBytes(node.localStack);
            const peakLabel = make('text', { x: 112, y: 55, class: 'node-meta-label' }, group);
            peakLabel.textContent = 'PEAK';
            const peakValue = make('text', { x: 176, y: 55, class: 'node-meta-value', 'text-anchor': 'end' }, group);
            peakValue.textContent = formatBytes(node.maxStack);
            make('rect', { x: 12, y: 68, width: 164, height: 2, rx: 1, class: 'node-bar-track' }, group);
            make('rect', { x: 12, y: 68, width: Math.max(3, Math.round(164 * (node.maxStack || 0) / maxStack)),
                height: 2, rx: 1, class: 'node-bar-fill' }, group);
            make('circle', { cx: 0, cy: nodeHeight / 2, r: 3.5, class: 'node-port' }, group);
            make('circle', { cx: nodeWidth, cy: nodeHeight / 2, r: 3.5, class: 'node-port' }, group);
            group.addEventListener('click', () => selectGraphNode(svg, node.id));
            group.addEventListener('dblclick', () => openGraphFunction(node.name));
            group.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectGraphNode(svg, node.id);
                }
            });
        });
        stackGraphContainer.appendChild(svg);
        applyGraphZoom();
        if (!edges.length) {
            const hint = document.createElement('div');
            hint.className = 'stack-graph-empty-links';
            hint.textContent = 'Call links are not available for this report.';
            stackGraphContainer.appendChild(hint);
        }
        if (graphSelectedId && nodeById.has(graphSelectedId)) {
            selectGraphNode(svg, graphSelectedId, false);
        } else if (stackGraphInspector) {
            stackGraphInspector.hidden = true;
        }
    }

    function openGraphFunction(name) {
        const fn = currentStackReport?.functions?.find(item => item.name === name);
        if (fn?.file) {
            vscode.postMessage({ type: 'open-file', path: fn.file, line: fn.line ? fn.line - 1 : 0 });
        }
    }

    function applyGraphZoom() {
        const svg = stackGraphContainer?.querySelector('.stack-graph');
        if (svg) {
            svg.setAttribute('width', Math.round(Number(svg.dataset.baseWidth) * graphZoom));
            svg.setAttribute('height', Math.round(Number(svg.dataset.baseHeight) * graphZoom));
        }
        if (stackZoomLabel) { stackZoomLabel.textContent = `${Math.round(graphZoom * 100)}%`; }
        if (stackZoomOut) { stackZoomOut.disabled = graphZoom <= 0.65; }
        if (stackZoomIn) { stackZoomIn.disabled = graphZoom >= 1.5; }
    }

    function selectGraphNode(svg, nodeId, scroll = true) {
        graphSelectedId = nodeId;
        const related = new Set([nodeId]);
        svg.querySelectorAll('.stack-graph-wire').forEach(wire => {
            const active = wire.dataset.from === nodeId || wire.dataset.to === nodeId;
            wire.classList.toggle('is-selected', active);
            wire.classList.toggle('is-dimmed', !active);
            if (active) { related.add(wire.dataset.from); related.add(wire.dataset.to); }
        });
        svg.querySelectorAll('.stack-graph-node').forEach(group => {
            group.classList.toggle('is-selected', group.dataset.id === nodeId);
            group.classList.toggle('is-dimmed', !related.has(group.dataset.id));
        });
        const group = [...svg.querySelectorAll('.stack-graph-node')].find(el => el.dataset.id === nodeId);
        if (scroll && group) { group.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); }
        if (!stackGraphInspector || !currentStackReport) { return; }
        const node = currentStackReport.callGraph?.nodes.find(item => item.id === nodeId);
        if (!node) { return; }
        const edges = currentStackReport.callGraph?.edges || [];
        const callers = edges.filter(edge => edge.to === nodeId && edge.from !== nodeId).length;
        const callees = edges.filter(edge => edge.from === nodeId && edge.to !== nodeId).length;
        stackGraphInspector.replaceChildren();
        const info = document.createElement('div');
        info.className = 'stack-inspector-main';
        const name = document.createElement('strong');
        name.textContent = node.name;
        const meta = document.createElement('span');
        meta.textContent = `${callers} callers · ${callees} calls · ${formatBytes(node.maxStack)} peak`;
        info.append(name, meta);
        stackGraphInspector.appendChild(info);
        if (currentStackReport.functions.some(fn => fn.name === nodeId && fn.file)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.title = 'Open source';
            button.setAttribute('aria-label', `Open ${node.name} in source`);
            button.textContent = 'Open';
            button.addEventListener('click', () => openGraphFunction(nodeId));
            stackGraphInspector.appendChild(button);
        }
        stackGraphInspector.hidden = false;
    }

    function renderFilteredStackFunctions() {
        if (!stackFnList || !currentStackReport) { return; }
        stackFnList.innerHTML = '';

        const query = stackSearch ? stackSearch.value.trim().toLowerCase() : '';
        const list = (currentStackReport.functions || []).filter(fn => {
            return !query || fn.name.toLowerCase().includes(query);
        });

        if (list.length === 0) {
            stackFnList.innerHTML = '<li class="stack-empty-hint">No functions match the search filter.</li>';
            return;
        }

        const peak = currentStackReport.peakStack || 1;

        // Sort by maxStack descending
        list.sort((a, b) => b.maxStack - a.maxStack);

        list.forEach(fn => {
            const card = document.createElement('li');
            const isRec = fn.isRecursive || fn.hasInfiniteSelfRecursion;
            card.className = `stack-fn-card ${isRec ? 'is-recursive' : 'is-safe'}`;
            card.id = `stack-fn-${escapeId(fn.name)}`;

            const pct = Math.max(4, Math.min(100, Math.round((fn.maxStack / peak) * 100)));

            card.innerHTML = `
                <div class="stack-fn-header">
                    <span class="stack-fn-name">
                        <i data-lucide="code-2"></i>
                        <span>${escapeHtml(fn.name)}()</span>
                    </span>
                    <div class="stack-fn-badges">
                        ${isRec ? '<span class="stack-pill pill-danger">⚠️ Cycle</span>' : '<span class="stack-pill pill-safe">Safe</span>'}
                        ${fn.hasDynamicAlloca ? '<span class="stack-pill pill-danger">alloca()</span>' : ''}
                    </div>
                </div>
                <div class="stack-bar-wrap">
                    <div class="stack-bar-fill ${isRec ? 'fill-danger' : ''}" style="width: ${pct}%"></div>
                </div>
                <div class="stack-fn-meta">
                    <span>Local frame: <strong>${formatBytes(fn.localStack)}</strong></span>
                    <span>Max stack: <strong>${formatBytes(fn.maxStack)}</strong> (${pct}%)</span>
                </div>
            `;

            card.addEventListener('click', () => {
                if (fn.file) {
                    vscode.postMessage({
                        type: 'open-file',
                        path: fn.file,
                        line: fn.line ? fn.line - 1 : 0
                    });
                }
            });

            stackFnList.appendChild(card);
        });

        if (typeof lucide !== 'undefined') { lucide.createIcons(); }
    }

    function highlightStackFunction(funcName) {
        if (!funcName) { return; }
        const graph = stackGraphContainer?.querySelector('.stack-graph');
        if (graph) { selectGraphNode(graph, funcName); }
        const card = document.getElementById(`stack-fn-${escapeId(funcName)}`);
        if (card) {
            if (!graph) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
            card.classList.add('is-focused');
            setTimeout(() => card.classList.remove('is-focused'), 2000);
        }
    }

    function escapeId(name) {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_');
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
    }

    // Notify the extension host that the webview is ready and query initial binary/analysis status
    try {
        vscode.postMessage({ type: 'webview-ready' });
    } catch {
        // Ignore if posting message is not permitted yet
    }

}());

