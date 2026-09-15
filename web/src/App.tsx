import {
  Route,
  Navigate,
  useParams,
  RouterProvider,
  createBrowserRouter,
  createHashRouter,
  createRoutesFromElements,
} from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { SetupPage } from './pages/SetupPage';
import { SetupProvidersPage } from './pages/SetupProvidersPage';
import { SetupChannelsPage } from './pages/SetupChannelsPage';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { APP_BASE, shouldUseHashRouter } from './utils/url';
import { shouldPreloadChatRoute } from './utils/chat-route-preload';
import { Toaster } from '@/components/ui/sonner';

let chatPagePromise:
  | Promise<{ default: typeof import('./pages/ChatPage').ChatPage }>
  | undefined;
const loadChatPage = () =>
  (chatPagePromise ??= import('./pages/ChatPage').then((m) => ({
    default: m.ChatPage,
  })));
const ChatPage = lazy(loadChatPage);

// Start the expensive chat split as soon as the entry executes, but only for
// the default/chat routes. Static HTML modulepreloads made login, setup, tasks,
// and memory download ChatPage + MarkdownRenderer even when never used.
if (
  typeof window !== 'undefined' &&
  shouldPreloadChatRoute(
    window.location.pathname,
    window.location.hash,
    APP_BASE,
  )
) {
  void loadChatPage();
}
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const BillingPage = lazy(() => import('./pages/BillingPage'));
// Keep expensive non-chat routes out of the entry chunk.
const MemoryPage = lazy(() =>
  import('./pages/MemoryPage').then((m) => ({ default: m.MemoryPage })),
);
const UsersPage = lazy(() =>
  import('./pages/UsersPage').then((m) => ({ default: m.UsersPage })),
);
const MonitorPage = lazy(() =>
  import('./pages/MonitorPage').then((m) => ({ default: m.MonitorPage })),
);
const HrOverviewPage = lazy(() =>
  import('./pages/hr/HrOverviewPage').then((m) => ({
    default: m.HrOverviewPage,
  })),
);
const HrJobsPage = lazy(() =>
  import('./pages/hr/HrJobsPage').then((m) => ({
    default: m.HrJobsPage,
  })),
);
const HrCandidatesPage = lazy(() =>
  import('./pages/hr/HrCandidatesPage').then((m) => ({
    default: m.HrCandidatesPage,
  })),
);
const HrBoardPage = lazy(() =>
  import('./pages/hr/HrBoardPage').then((m) => ({
    default: m.HrBoardPage,
  })),
);
const HrCandidateDetailPage = lazy(() =>
  import('./pages/hr/HrCandidateDetailPage').then((m) => ({
    default: m.HrCandidateDetailPage,
  })),
);
const HrJobDetailPage = lazy(() =>
  import('./pages/hr/HrJobDetailPage').then((m) => ({
    default: m.HrJobDetailPage,
  })),
);
const HrQuestionsPage = lazy(() =>
  import('./pages/hr/HrQuestionsPage').then((m) => ({
    default: m.HrQuestionsPage,
  })),
);
const HrAnalysisJobsPage = lazy(() =>
  import('./pages/hr/HrAnalysisJobsPage').then((m) => ({
    default: m.HrAnalysisJobsPage,
  })),
);
const HrAnalyticsPage = lazy(() =>
  import('./pages/hr/HrAnalyticsPage').then((m) => ({
    default: m.HrAnalyticsPage,
  })),
);
const HrFeishuPage = lazy(() =>
  import('./pages/hr/HrFeishuPage').then((m) => ({
    default: m.HrFeishuPage,
  })),
);

function CapabilitiesRedirect() {
  const { section } = useParams<{ section?: string }>();
  const activeSection =
    section && ['skills', 'mcp', 'plugins'].includes(section)
      ? section
      : 'skills';
  return (
    <Navigate
      to={`/settings?tab=capabilities&section=${activeSection}`}
      replace
    />
  );
}

const appRoutes = createRoutesFromElements(
  <>
    {/* Public Routes */}
    <Route path="/login" element={<LoginPage />} />
    <Route path="/register" element={<RegisterPage />} />
    <Route path="/setup" element={<SetupPage />} />
    <Route
      path="/setup/providers"
      element={
        <AuthGuard>
          <SetupProvidersPage />
        </AuthGuard>
      }
    />
    <Route
      path="/setup/channels"
      element={
        <AuthGuard>
          <SetupChannelsPage />
        </AuthGuard>
      }
    />

    {/* Protected Routes with Layout */}
    <Route
      element={
        <AuthGuard>
          <AppLayout />
        </AuthGuard>
      }
    >
      <Route
        path="/chat/:groupFolder?"
        element={
          <Suspense
            fallback={
              <div
                className="flex h-full items-center justify-center text-sm text-muted-foreground motion-safe:animate-pulse"
                role="status"
                aria-live="polite"
              >
                正在加载会话…
              </div>
            }
          >
            <ChatPage />
          </Suspense>
        }
      />
      <Route path="/groups" element={<Navigate to="/chat" replace />} />
      <Route
        path="/agent-profiles"
        element={<Navigate to="/settings?tab=agent-profiles" replace />}
      />
      <Route
        path="/tasks"
        element={<Navigate to="/settings?tab=tasks" replace />}
      />
      <Route
        path="/monitor"
        element={
          <AuthGuard requiredPermission="manage_system_config">
            <Suspense fallback={null}>
              <MonitorPage />
            </Suspense>
          </AuthGuard>
        }
      />
      <Route
        path="/usage"
        element={<Navigate to="/settings?tab=usage" replace />}
      />
      <Route
        path="/billing"
        element={
          <Suspense fallback={null}>
            <BillingPage />
          </Suspense>
        }
      />
      <Route
        path="/memory"
        element={
          <Suspense fallback={null}>
            <MemoryPage />
          </Suspense>
        }
      />
      <Route
        path="/capabilities/:section?"
        element={<CapabilitiesRedirect />}
      />
      <Route path="/hr" element={<HrOverviewPage />} />
      <Route path="/hr/jobs" element={<HrJobsPage />} />
      <Route path="/hr/candidates" element={<HrCandidatesPage />} />
      <Route path="/hr/questions" element={<HrQuestionsPage />} />
      <Route path="/hr/analysis-jobs" element={<HrAnalysisJobsPage />} />
      <Route path="/hr/analytics" element={<HrAnalyticsPage />} />
      <Route path="/hr/feishu" element={<HrFeishuPage />} />
      <Route path="/hr/board" element={<HrBoardPage />} />
      <Route path="/hr/jobs/:jobId" element={<HrJobDetailPage />} />
      <Route
        path="/hr/candidates/:candidateId"
        element={<HrCandidateDetailPage />}
      />
      <Route
        path="/skills"
        element={
          <Navigate to="/settings?tab=capabilities&section=skills" replace />
        }
      />
      <Route
        path="/mcp-servers"
        element={
          <Navigate to="/settings?tab=capabilities&section=mcp" replace />
        }
      />
      <Route
        path="/plugins"
        element={
          <Navigate to="/settings?tab=capabilities&section=plugins" replace />
        }
      />
      <Route
        path="/settings"
        element={
          <Suspense fallback={null}>
            <SettingsPage />
          </Suspense>
        }
      />
      <Route
        path="/users"
        element={
          <AuthGuard
            requiredAnyPermissions={[
              'manage_users',
              'manage_invites',
              'view_audit_log',
            ]}
          >
            <Suspense fallback={null}>
              <UsersPage />
            </Suspense>
          </AuthGuard>
        }
      />
    </Route>

    {/* Default redirect — go through AuthGuard to detect setup state */}
    <Route path="/" element={<Navigate to="/hr" replace />} />
    <Route path="*" element={<Navigate to="/hr" replace />} />
  </>,
);

export function createAppRouter(useHashRouter = shouldUseHashRouter()) {
  const options = {
    basename: APP_BASE === '/' ? undefined : APP_BASE,
  };
  return useHashRouter
    ? createHashRouter(appRoutes, options)
    : createBrowserRouter(appRoutes, options);
}

let appRouter: ReturnType<typeof createAppRouter> | undefined;

function getAppRouter() {
  appRouter ??= createAppRouter();
  return appRouter;
}

export function App() {
  return (
    <>
      <Toaster position="top-right" richColors />
      <RouterProvider router={getAppRouter()} />
    </>
  );
}
