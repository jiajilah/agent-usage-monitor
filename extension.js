'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { collectUsage } = require('./usage');

let panel = null;
let loading = false;

function settings() {
  const config = vscode.workspace.getConfiguration('agentUsage');
  return {
    lookbackDays: config.get('lookbackDays', 90),
    codexHome: config.get('codexHome', ''),
    claudeHome: config.get('claudeHome', ''),
    geminiHome: config.get('geminiHome', ''),
    antigravityModel: config.get('antigravityModel', 'gemini')
  };
}

async function loadAndPost(context, reason) {
  if (!panel || loading) return;
  loading = true;
  panel.webview.postMessage({ type: 'loading', reason });
  try {
    const cacheFile = path.join(context.globalStorageUri.fsPath, 'usage-cache.json');
    const antigravityScript = path.join(context.extensionPath, 'antigravity_usage.py');
    const data = await collectUsage({ ...settings(), cacheFile, antigravityScript });
    if (panel) panel.webview.postMessage({ type: 'data', data });
  } catch (err) {
    if (panel) panel.webview.postMessage({ type: 'error', message: String((err && err.stack) || err) });
  } finally {
    loading = false;
  }
}

function openPanel(context) {
  if (panel) {
    // Reload the page too, so an updated panel.html shows without closing the tab.
    panel.webview.html = fs.readFileSync(path.join(context.extensionPath, 'media', 'panel.html'), 'utf8');
    panel.reveal(vscode.ViewColumn.One);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'agUsageDashboard',
    'Agent Usage',
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'media', 'icon.svg'));
  panel.webview.html = fs.readFileSync(path.join(context.extensionPath, 'media', 'panel.html'), 'utf8');
  const timer = setInterval(() => {
    if (panel && panel.visible) loadAndPost(context, 'auto');
  }, 5 * 60 * 1000);
  panel.onDidDispose(() => {
    clearInterval(timer);
    panel = null;
  }, null, context.subscriptions);
  panel.webview.onDidReceiveMessage((message) => {
    if (message && message.type === 'ready') loadAndPost(context, 'initial');
    if (message && message.type === 'refresh') loadAndPost(context, 'manual');
    if (message && message.type === 'visible') loadAndPost(context, 'auto');
    if (message && message.type === 'openSettings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'agentUsage');
    }
  }, null, context.subscriptions);
}

function activate(context) {
  try {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  } catch (err) {
    /* storage is created lazily by the cache writer too */
  }
  context.subscriptions.push(
    vscode.commands.registerCommand('agentUsage.open', () => openPanel(context)),
    vscode.commands.registerCommand('agentUsage.refresh', () => {
      openPanel(context);
      loadAndPost(context, 'manual');
    })
  );
}

function deactivate() {
  panel = null;
}

module.exports = { activate, deactivate };
