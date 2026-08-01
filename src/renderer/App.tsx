import React, { useEffect, useRef } from 'react';

import { SubagentDetailModal } from './components/chat/SubagentDetailModal';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ContextSwitchOverlay } from './components/common/ContextSwitchOverlay';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { TabbedLayout } from './components/layout/TabbedLayout';
import { useTheme } from './hooks/useTheme';
import { findPane } from './store/utils/paneHelpers';
import {
  buildProjectPath,
  buildSessionPath,
  parseUrlPath,
  type UrlPathParams,
} from './utils/urlRouting';
import { api } from './api';
import { initializeNotificationListeners, useStore } from './store';

export const App = (): React.JSX.Element => {
  // Initialize theme on app load
  useTheme();

  // Deep link: on first load, open the session/project encoded in the URL (if any).
  // Session links resolve immediately. Project-only links ("/{projectId}") need
  // repositoryGroups fetched first (it's the superset source - every project
  // appears as a repo group, even non-git ones - see DashboardView), so this
  // fetches it directly rather than racing other components' mount effects.
  const pendingDeepLinkRef = useRef<UrlPathParams | null>(parseUrlPath(window.location.pathname));

  useEffect(() => {
    const pending = pendingDeepLinkRef.current;
    if (!pending) return;

    if (pending.sessionId) {
      useStore.getState().navigateToSession(pending.projectId, pending.sessionId);
      pendingDeepLinkRef.current = null;
      return;
    }

    const state = useStore.getState();
    const resolve = (): void => {
      useStore.getState().selectProjectContext(pending.projectId);
      pendingDeepLinkRef.current = null;
    };
    if (state.repositoryGroups.length > 0) {
      resolve();
    } else {
      void state.fetchRepositoryGroups().then(resolve);
    }
  }, []);

  // Keep the URL in sync with the current workspace/session, so it can be
  // bookmarked or shared as a direct link.
  const activeUrlPath = useStore((state) => {
    const pane = findPane(state.paneLayout, state.paneLayout.focusedPaneId);
    const tab = pane?.tabs.find((t) => t.id === pane.activeTabId);
    if (tab?.type === 'session' && tab.projectId && tab.sessionId) {
      return buildSessionPath(tab.projectId, tab.sessionId);
    }
    if (state.activeProjectId) {
      return buildProjectPath(state.activeProjectId);
    }
    return null;
  });

  useEffect(() => {
    const newPath = activeUrlPath ?? '/';
    if (window.location.pathname !== newPath) {
      window.history.replaceState(null, '', newPath);
    }
  }, [activeUrlPath]);

  // Dismiss splash screen once React is ready
  useEffect(() => {
    const splash = document.getElementById('splash');
    if (splash) {
      splash.style.opacity = '0';
      setTimeout(() => splash.remove(), 300);
    }
  }, []);

  // Initialize context system (before notification listeners)
  useEffect(() => {
    void useStore.getState().initializeContextSystem();
  }, []);

  // Refresh available contexts when SSH connection state changes
  useEffect(() => {
    if (!api.ssh?.onStatus) return;
    const cleanup = api.ssh.onStatus(() => {
      void useStore.getState().fetchAvailableContexts();
    });
    return cleanup;
  }, []);

  // Initialize IPC event listeners (notifications, file changes)
  useEffect(() => {
    const cleanup = initializeNotificationListeners();
    return cleanup;
  }, []);

  return (
    <ErrorBoundary>
      <ContextSwitchOverlay />
      <TabbedLayout />
      <ConfirmDialog />
      <SubagentDetailModal />
    </ErrorBoundary>
  );
};
