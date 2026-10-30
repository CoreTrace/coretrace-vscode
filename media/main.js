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
    const stackTreeEl = document.getElementById('stack-tree');
    const stackDetails = document.getElementById('stack-details');
    const stackTreeCount = document.getElementById('stack-tree-count');
    const stackViewTree = document.getElementById('stack-view-tree');
    const stackViewRanking = document.getElementById('stack-view-ranking');
    const stackTreeActions = document.getElementById('stack-tree-actions');
    const stackHotPath = document.getElementById('stack-hot-path');
    const stackExpandAll = document.getElementById('stack-expand-all');
    const stackCollapseAll = document.getElementById('stack-collapse-all');
    const stackSearch = document.getElementById('stack-search');
    const stackTreeLib = window.CoreTraceStackTree;
    let stackModel = null;
    let stackView = 'tree';
    let stackExpanded = new Set();
    // Until the user opens or closes a row, each report of a workspace scan
    // gets the default layout; afterwards their layout is kept.
    let stackTreeTouched = false;
    let stackSelectedKey = null;
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
    let ignoredCount = 0;
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

        const parentMenu = button.closest('.analysis-mode-menu');
        const existingTimer = closeTimeouts.get(menu);
        if (existingTimer) {
            clearTimeout(existingTimer);
            closeTimeouts.delete(menu);
        }

        if (open) {
            if (parentMenu) { parentMenu.classList.add('menu-open'); }
            menu.classList.remove('is-closing');
            menu.hidden = false;
            button.setAttribute('aria-expanded', 'true');
        } else {
            button.setAttribute('aria-expanded', 'false');
            if (menu.hidden) {
                if (parentMenu) { parentMenu.classList.remove('menu-open'); }
                return;
            }
            menu.classList.add('is-closing');
            const timer = setTimeout(() => {
                menu.hidden = true;
                menu.classList.remove('is-closing');
                if (parentMenu) { parentMenu.classList.remove('menu-open'); }
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
        if (!workspace && modeChanged) {
            setValue('only-dir', '');
            setValue('exclude-dir', '');
        }
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
    if (stackSearch) { stackSearch.addEventListener('input', renderStackView); }
    if (stackViewTree) { stackViewTree.addEventListener('click', () => setStackView('tree')); }
    if (stackViewRanking) { stackViewRanking.addEventListener('click', () => setStackView('ranking')); }
    if (stackHotPath) { stackHotPath.addEventListener('click', showHotPath); }
    if (stackExpandAll) {
        stackExpandAll.addEventListener('click', () => {
            if (!stackModel) { return; }
            stackExpanded = stackTreeLib.allExpanded(stackModel);
            stackTreeTouched = true;
            renderStackView();
        });
    }
    if (stackCollapseAll) {
        stackCollapseAll.addEventListener('click', () => {
            stackExpanded = new Set();
            stackTreeTouched = true;
            renderStackView();
        });
    }
    if (stackTreeEl) {
        stackTreeEl.addEventListener('click', onStackTreeClick);
        stackTreeEl.addEventListener('dblclick', event => {
            const row = event.target.closest('.stack-row');
            if (row && row.dataset.id && !event.target.closest('.stack-row-twisty')) { openStackFunction(row.dataset.id); }
        });
        stackTreeEl.addEventListener('keydown', onStackTreeKeydown);
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
        restoreToolSelection('.static-tool', saved.staticTools, saved.staticEnabled !== false, saved.dynamicTools);
        restoreToolSelection('.dynamic-tool', saved.dynamicTools, saved.dynamicEnabled !== false);
        const isWs = persistedState.scanWorkspace === true;
        setValue('only-function', saved.onlyFunction || '');
        setValue('only-dir', isWs ? (saved.onlyDir || '') : '');
        setValue('exclude-dir', isWs ? (saved.excludeDir || '') : '');
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
            onlyDir: scanWorkspace ? valueOf('only-dir') : '',
            excludeDir: scanWorkspace ? valueOf('exclude-dir') : '',
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

    function restoreToolSelection(selector, savedTools, enabled, fallbackSavedTools) {
        const selected = Array.isArray(savedTools) ? savedTools : null;
        document.querySelectorAll(selector).forEach(tool => {
            if (selected) {
                const inSaved = selected.includes(tool.value);
                const inFallback = Array.isArray(fallbackSavedTools) && fallbackSavedTools.includes(tool.value);
                tool.checked = inSaved || inFallback;
            } else {
                tool.checked = enabled;
            }
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
                handleAnalysisResult(msg.data, msg.restored === true, msg.savedAt, msg.refresh === true);
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
                if (msg.functionName && stackModel) {
                    const id = stackTreeLib.resolveName(stackModel, msg.functionName);
                    if (id) { revealStackFunction(id); }
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

    function handleAnalysisResult(sarif, restored = false, savedAt, refresh = false) {
        // A refresh only re-applies the ignore list: keep the current status.
        if (!refresh) {
            setRunning(false);
            const savedLabel = Number.isFinite(savedAt) ? new Date(savedAt).toLocaleString() : 'Saved results';
            setStatus(restored ? 'Last analysis' : 'Analysis complete', restored ? savedLabel : 'Findings are shown below', 'success');
            setProgress(100);
        }

        if (emptyState) { emptyState.style.display = 'none'; }
        if (resultsContainer) { resultsContainer.classList.remove('results-hidden'); }
        if (vulnList) { vulnList.innerHTML = ''; }

        findings = [];
        ignoredCount = 0;
        const seenFindings = new Set();

        if (sarif && sarif.runs) {
            sarif.runs.forEach(run => {
                (run.results || []).forEach(res => {
                    const loc = res.locations && res.locations[0] && res.locations[0].physicalLocation;
                    const key = `${res.ruleId || ''}|${loc?.artifactLocation?.uri || ''}|${loc?.region?.startLine ?? ''}|${res.message?.text || ''}`;
                    if (!seenFindings.has(key)) {
                        seenFindings.add(key);
                        if (res.properties && res.properties.ctraceIgnored === true) {
                            ignoredCount++;
                        } else {
                            findings.push(res);
                        }
                    }
                });
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
            appendIgnoredNotice();
            if (typeof lucide !== 'undefined') { lucide.createIcons(); }
        }

        if (tabVulnBadge) {
            tabVulnBadge.textContent = String(count);
        }
    }

    function clearDisplayedResults() {
        findings = [];
        stackModel = null;
        stackExpanded = new Set();
        stackTreeTouched = false;
        stackSelectedKey = null;
        if (vulnList) { vulnList.replaceChildren(); }
        if (stackTreeEl) {
            stackTreeEl.innerHTML = '<div class="stack-empty-hint">Run the stack analyzer to view functions and calls.</div>';
        }
        if (stackDetails) { stackDetails.hidden = true; }
        if (stackTreeCount) { stackTreeCount.textContent = '0 functions'; }
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
        stackModel = stackTreeLib.createModel(report);
        if (!stackTreeTouched) { stackExpanded = stackTreeLib.defaultExpanded(stackModel); }

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

        renderStackView();
    }

    const TWISTY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function setStackView(view) {
        stackView = view;
        stackViewTree?.classList.toggle('active', view === 'tree');
        stackViewTree?.setAttribute('aria-pressed', String(view === 'tree'));
        stackViewRanking?.classList.toggle('active', view === 'ranking');
        stackViewRanking?.setAttribute('aria-pressed', String(view === 'ranking'));
        if (stackTreeActions) { stackTreeActions.hidden = view !== 'tree'; }
        stackSelectedKey = null;
        renderStackView();
    }

    function stackQuery() {
        return stackSearch ? stackSearch.value.trim() : '';
    }

    function renderStackView() {
        if (!stackTreeEl || !stackModel) { return; }
        const query = stackQuery();
        const hadFocus = stackTreeEl.contains(document.activeElement);
        const result = stackView === 'tree'
            ? stackTreeLib.flattenTree(stackModel, { expanded: stackExpanded, query })
            : { rows: stackTreeLib.rankedRows(stackModel, query), truncated: false, matchCount: null };

        if (stackTreeCount) {
            const total = stackModel.nodes.size;
            stackTreeCount.textContent = query
                ? `${stackView === 'tree' ? result.matchCount : result.rows.length} of ${total} functions`
                : `${total} function${total > 1 ? 's' : ''} · ${stackModel.callCount} call${stackModel.callCount > 1 ? 's' : ''}`;
        }

        stackTreeEl.replaceChildren();
        if (result.rows.length === 0) {
            const hint = document.createElement('div');
            hint.className = 'stack-empty-hint';
            hint.textContent = query ? 'No functions match the filter.' : 'No function data available.';
            stackTreeEl.appendChild(hint);
        }
        result.rows.forEach(row => stackTreeEl.appendChild(buildStackRow(row, query)));
        if (result.truncated) {
            const notice = document.createElement('div');
            notice.className = 'stack-tree-notice';
            notice.textContent = 'Too many rows to show them all. Filter or collapse to narrow the tree.';
            stackTreeEl.appendChild(notice);
        }

        const rows = [...stackTreeEl.querySelectorAll('.stack-row')];
        let current = rows.find(row => row.dataset.key === stackSelectedKey);
        if (!current) { stackSelectedKey = null; }
        (current || rows[0])?.setAttribute('tabindex', '0');
        current?.classList.add('is-selected');
        current?.setAttribute('aria-selected', 'true');
        if (hadFocus) { (current || rows[0])?.focus({ preventScroll: true }); }
        renderStackDetails(current?.dataset.id);
    }

    function buildStackRow(row, query) {
        const el = document.createElement('div');
        el.className = 'stack-row';
        el.setAttribute('role', 'treeitem');
        el.setAttribute('tabindex', '-1');
        el.setAttribute('aria-level', String(row.depth + 1));
        el.setAttribute('aria-selected', 'false');
        if (row.expandable) { el.setAttribute('aria-expanded', String(row.expanded)); }
        el.dataset.key = row.key;
        // Through the CSSOM: the webview CSP blocks inline style attributes.
        el.style.setProperty('--depth', String(row.depth));

        const guides = document.createElement('span');
        guides.className = 'stack-row-guides';
        const twisty = document.createElement('span');
        twisty.className = `stack-row-twisty${row.expandable ? '' : ' is-leaf'}`;
        if (row.expandable) { twisty.innerHTML = TWISTY_ICON; }
        el.append(guides, twisty);

        if (row.kind === 'group') {
            el.classList.add('is-group');
            const label = document.createElement('span');
            label.className = 'stack-row-name';
            label.textContent = 'No call links';
            const count = document.createElement('span');
            count.className = 'stack-row-value';
            count.textContent = String(row.count);
            el.append(label, count);
            el.title = 'Functions that neither call nor are called by another analysed function';
            return el;
        }

        const node = stackModel.nodes.get(row.id);
        el.dataset.id = row.id;
        const pct = Math.min(100, Math.round(((node.maxStack || 0) / stackModel.peak) * 100));
        el.style.setProperty('--pct', `${pct}%`);
        if (row.hot) { el.classList.add('is-hot'); }
        if (row.isCycleRef) { el.classList.add('is-cycle-ref'); }

        const name = document.createElement('span');
        name.className = 'stack-row-name';
        appendHighlighted(name, node.name, query);

        const badges = document.createElement('span');
        badges.className = 'stack-row-badges';
        const isRecursive = node.isRecursive || node.hasInfiniteSelfRecursion;
        if (row.isCycleRef) {
            badges.appendChild(stackBadge('↻', 'badge-danger', 'Recursive call: this function is already on the path above'));
        } else if (isRecursive) {
            badges.appendChild(stackBadge('↻', 'badge-danger', 'Part of a recursive cycle: its real stack use can be higher'));
        }
        if (node.exceedsLimit) { badges.appendChild(stackBadge('limit', 'badge-danger', 'Exceeds the stack limit')); }
        if (node.hasDynamicAlloca) { badges.appendChild(stackBadge('alloca', 'badge-warning', 'Dynamic stack allocation')); }

        const value = document.createElement('span');
        value.className = 'stack-row-value';
        value.textContent = row.isCycleRef ? '' : formatPeak(node);

        el.append(name, badges, value);
        el.title = [
            node.name,
            `Local ${formatBytes(node.localStack)} · Peak ${formatPeak(node)}`,
            node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : '',
        ].filter(Boolean).join('\n');
        return el;
    }

    function stackBadge(text, className, title) {
        const badge = document.createElement('span');
        badge.className = `stack-badge ${className}`;
        badge.textContent = text;
        badge.title = title;
        return badge;
    }

    function appendHighlighted(parent, text, query) {
        const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
        if (index < 0) {
            parent.textContent = text;
            return;
        }
        const mark = document.createElement('mark');
        mark.textContent = text.slice(index, index + query.length);
        parent.append(text.slice(0, index), mark, text.slice(index + query.length));
    }

    function formatPeak(node) {
        if (node.maxStackUnknown) {
            return node.maxStackLowerBound ? `≥ ${formatBytes(node.maxStackLowerBound)}` : '?';
        }
        return formatBytes(node.maxStack);
    }

    function onStackTreeClick(event) {
        const row = event.target.closest('.stack-row');
        if (!row) { return; }
        const key = row.dataset.key;
        if (event.target.closest('.stack-row-twisty') || !row.dataset.id) {
            if (row.hasAttribute('aria-expanded')) { toggleStackRow(key); }
            return;
        }
        selectStackRow(row);
        // A click opens but never closes: selecting a parent to read its
        // details must not hide its callees.
        if (row.getAttribute('aria-expanded') === 'false') { toggleStackRow(key); }
    }

    function toggleStackRow(key) {
        if (stackExpanded.has(key)) {
            stackExpanded.delete(key);
        } else {
            stackExpanded.add(key);
        }
        stackTreeTouched = true;
        renderStackView();
    }

    function selectStackRow(row, focus = true) {
        if (!stackTreeEl) { return; }
        stackTreeEl.querySelectorAll('.stack-row').forEach(other => {
            const selected = other === row;
            other.classList.toggle('is-selected', selected);
            other.setAttribute('aria-selected', String(selected));
            other.setAttribute('tabindex', selected ? '0' : '-1');
        });
        stackSelectedKey = row.dataset.key;
        if (focus) { row.focus({ preventScroll: true }); }
        renderStackDetails(row.dataset.id);
    }

    function onStackTreeKeydown(event) {
        const row = event.target.closest('.stack-row');
        if (!row || !stackTreeEl) { return; }
        const rows = [...stackTreeEl.querySelectorAll('.stack-row')];
        const index = rows.indexOf(row);
        const move = target => {
            if (!target) { return; }
            if (target.dataset.id) {
                selectStackRow(target);
            } else {
                rows.forEach(other => other.setAttribute('tabindex', other === target ? '0' : '-1'));
                target.focus({ preventScroll: true });
            }
            target.scrollIntoView({ block: 'nearest' });
        };
        const expanded = row.getAttribute('aria-expanded');
        switch (event.key) {
            case 'ArrowDown': move(rows[index + 1]); break;
            case 'ArrowUp': move(rows[index - 1]); break;
            case 'Home': move(rows[0]); break;
            case 'End': move(rows[rows.length - 1]); break;
            case 'ArrowRight':
                if (expanded === 'false') { toggleStackRow(row.dataset.key); }
                else if (expanded === 'true') { move(rows[index + 1]); }
                break;
            case 'ArrowLeft':
                if (expanded === 'true') {
                    toggleStackRow(row.dataset.key);
                } else {
                    const parent = stackTreeLib.parentKey(row.dataset.key);
                    move(rows.find(other => other.dataset.key === parent));
                }
                break;
            case 'Enter':
                if (row.dataset.id) { openStackFunction(row.dataset.id); }
                else { toggleStackRow(row.dataset.key); }
                break;
            case ' ':
                if (row.dataset.id) { selectStackRow(row); }
                else { toggleStackRow(row.dataset.key); }
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    function renderStackDetails(id) {
        if (!stackDetails) { return; }
        const node = id && stackModel ? stackModel.nodes.get(id) : null;
        if (!node) {
            stackDetails.hidden = true;
            stackDetails.replaceChildren();
            return;
        }
        const header = document.createElement('div');
        header.className = 'stack-details-header';
        const name = document.createElement('strong');
        name.textContent = node.name;
        name.title = node.name;
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'stack-details-close';
        close.textContent = '×';
        close.title = 'Close';
        close.setAttribute('aria-label', 'Close details');
        close.addEventListener('click', () => {
            stackSelectedKey = null;
            renderStackView();
        });
        header.append(name, close);

        const stats = document.createElement('div');
        stats.className = 'stack-details-stats';
        const stat = (label, value) => {
            const cell = document.createElement('div');
            const strong = document.createElement('strong');
            strong.textContent = value;
            const span = document.createElement('span');
            span.textContent = label;
            cell.append(strong, span);
            return cell;
        };
        stats.append(
            stat('Local', formatBytes(node.localStack)),
            stat('Peak', formatPeak(node)),
            stat('Of max', `${Math.min(100, Math.round(((node.maxStack || 0) / stackModel.peak) * 100))}%`)
        );
        stackDetails.replaceChildren(header, stats);

        const callers = stackModel.parents.get(id).filter(other => other !== id);
        const callees = stackModel.children.get(id).filter(other => other !== id);
        if (callers.length > 0) { stackDetails.appendChild(stackLinkRow('Called by', callers)); }
        if (callees.length > 0) { stackDetails.appendChild(stackLinkRow('Calls', callees)); }

        if (node.file) {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'stack-details-open';
            const basename = String(node.file).split(/[\\/]/).pop();
            open.textContent = `${basename}${node.line ? `:${node.line}` : ''}`;
            open.title = `Open ${node.file}`;
            open.addEventListener('click', () => openStackFunction(id));
            stackDetails.appendChild(open);
        }
        stackDetails.hidden = false;
    }

    function stackLinkRow(label, ids) {
        const MAX_LINKS = 4;
        const row = document.createElement('div');
        row.className = 'stack-details-links';
        const title = document.createElement('span');
        title.className = 'stack-details-label';
        title.textContent = label;
        row.appendChild(title);
        ids.slice(0, MAX_LINKS).forEach(id => {
            const link = document.createElement('button');
            link.type = 'button';
            link.className = 'stack-link';
            link.textContent = id;
            link.title = `Show ${id} in the tree`;
            link.addEventListener('click', () => revealStackFunction(id));
            row.appendChild(link);
        });
        if (ids.length > MAX_LINKS) {
            const more = document.createElement('span');
            more.className = 'stack-details-label';
            more.textContent = `+${ids.length - MAX_LINKS}`;
            more.title = ids.slice(MAX_LINKS).join('\n');
            row.appendChild(more);
        }
        return row;
    }

    function revealStackFunction(id) {
        if (!stackModel) { return; }
        const target = stackTreeLib.pathTo(stackModel, id);
        if (!target) { return; }
        if (stackSearch) { stackSearch.value = ''; }
        if (stackView !== 'tree') { setStackView('tree'); }
        target.open.forEach(key => stackExpanded.add(key));
        stackTreeTouched = true;
        stackSelectedKey = target.key;
        renderStackView();
        const row = [...stackTreeEl.querySelectorAll('.stack-row')].find(item => item.dataset.key === target.key);
        if (row) {
            selectStackRow(row);
            row.scrollIntoView({ block: 'center' });
        }
    }

    function showHotPath() {
        if (!stackModel || stackModel.hotPath.length === 0) { return; }
        stackExpanded = new Set();
        const hottest = stackModel.hotPath[stackModel.hotPath.length - 1];
        // The hot path is not always the shortest route to its last function.
        const keys = [...stackModel.hotKeys];
        keys.slice(0, -1).forEach(key => stackExpanded.add(key));
        if (stackSearch) { stackSearch.value = ''; }
        stackTreeTouched = true;
        stackSelectedKey = keys[keys.length - 1] ?? null;
        renderStackView();
        const row = [...stackTreeEl.querySelectorAll('.stack-row')].find(item => item.dataset.key === stackSelectedKey);
        if (row && row.dataset.id === hottest) {
            selectStackRow(row);
            row.scrollIntoView({ block: 'nearest' });
        }
    }

    function openStackFunction(id) {
        const node = stackModel?.nodes.get(id);
        if (node?.file) {
            vscode.postMessage({ type: 'open-file', path: node.file, line: node.line ? node.line - 1 : 0 });
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
        if (findings.length > 0) { appendIgnoredNotice(); }
    }

    function appendIgnoredNotice() {
        if (!vulnList || ignoredCount === 0) { return; }
        const li = document.createElement('li');
        li.className = 'info-item ignored-notice';
        const text = document.createElement('span');
        text.textContent = `${ignoredCount} ignored finding${ignoredCount > 1 ? 's' : ''}`;
        const manage = document.createElement('button');
        manage.type = 'button';
        manage.className = 'link-btn';
        manage.textContent = 'Manage';
        manage.addEventListener('click', () => {
            vscode.postMessage({ type: 'execute-command', command: 'ctrace.manageIgnoredFindings' });
        });
        li.append(text, manage);
        vulnList.appendChild(li);
    }

    /** Same normalisation as cweIds() in DiagnosticsManager.ts. */
    function cweIds(properties) {
        if (!properties) { return []; }
        const raw = [].concat(properties.cwe === undefined ? [] : properties.cwe, Array.isArray(properties.tags) ? properties.tags : []);
        const ids = [];
        raw.forEach(value => {
            let match = null;
            if (typeof value === 'number') {
                match = [String(value), String(value)];
            } else if (typeof value === 'string') {
                match = value.match(/^(?:external\/cwe\/)?cwe[-/]?0*(\d{1,5})$/i) || value.match(/^0*(\d{1,5})$/);
            }
            if (match) {
                const id = `CWE-${Number(match[1])}`;
                if (!ids.includes(id)) { ids.push(id); }
            }
        });
        return ids;
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

        const props = res.properties || {};
        const cwes = cweIds(props);
        const fingerprint = typeof props.ctraceFingerprint === 'string' ? props.ctraceFingerprint : '';
        if (cwes.length > 0 || fingerprint || props.ctraceTool) {
            const footer = document.createElement('div');
            footer.className = 'vuln-footer';
            cwes.forEach(cwe => {
                const pill = document.createElement('button');
                pill.type = 'button';
                pill.className = 'vuln-cwe';
                pill.textContent = cwe;
                pill.title = `Open ${cwe} on cwe.mitre.org`;
                pill.addEventListener('click', event => {
                    event.stopPropagation();
                    vscode.postMessage({ type: 'open-cwe', cwe });
                });
                footer.appendChild(pill);
            });
            if (typeof props.ctraceTool === 'string') {
                const tool = document.createElement('span');
                tool.className = 'vuln-tool';
                tool.textContent = props.ctraceTool;
                footer.appendChild(tool);
            }
            if (fingerprint) {
                const ignore = document.createElement('button');
                ignore.type = 'button';
                ignore.className = 'vuln-ignore';
                ignore.title = 'Ignore this finding (stored in .coretrace-ignore.json)';
                ignore.setAttribute('aria-label', 'Ignore this finding');
                ignore.innerHTML = '<i data-lucide="eye-off"></i><span>Ignore</span>';
                ignore.addEventListener('click', event => {
                    event.stopPropagation();
                    vscode.postMessage({ type: 'ignore-finding', fingerprint, ruleId, path: filePath, line, message });
                });
                footer.appendChild(ignore);
            }
            li.appendChild(footer);
        }

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

