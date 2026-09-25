import type {
  CreateProjectInput,
  CreateTaskInput,
  Project,
  ProjectPatch,
  ProjectsPage,
  ProjectsQuery,
  ServiceStatus,
  SystemMetrics,
  Task,
  TaskPatch,
  TasksPage,
  TasksQuery,
  UpdateProjectInput,
  UpdateTaskInput,
} from '../types';

const TIMEOUT_MS = 5000;

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export type MutateMethod = 'POST' | 'PUT' | 'DELETE';

export async function apiSend<T>(
  path: string,
  method: MutateMethod,
  body?: unknown,
): Promise<T | null> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

export type { ProjectsQuery, TasksQuery };

function withQuery(path: string, query: ProjectsQuery | TasksQuery = {}): string {
  const params = new URLSearchParams();
  if (query.search?.trim()) params.set('search', query.search.trim());
  if (query.status) params.set('status', query.status);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
}

async function requiredResponse<T>(promise: Promise<T | null>): Promise<T> {
  const result = await promise;
  if (result === null) throw new Error('API error: очікувалися дані, але відповідь була порожньою');
  return result;
}

const listProjects = (query: ProjectsQuery = {}) =>
  apiGet<ProjectsPage>(withQuery('/api/data/projects', query));

const fetchProject = (id: number) => apiGet<Project>(`/api/data/projects/${id}`);

const listProjectTasks = async (
  projectId: number,
  query: TasksQuery = {},
): Promise<TasksPage> => {
  // The page shape is the public contract. Accepting a bare array as well keeps
  // the client compatible with older data-service versions during rollout.
  const result = await apiGet<TasksPage | Task[]>(
    withQuery(`/api/data/projects/${projectId}/tasks`, query),
  );
  if (Array.isArray(result)) {
    return { items: result, total: result.length, limit: result.length, offset: 0 };
  }
  return result;
};

const createProject = (input: CreateProjectInput) =>
  requiredResponse(apiSend<Project>('/api/data/projects', 'POST', input));

const updateProject = (id: number, patch: UpdateProjectInput | ProjectPatch) =>
  requiredResponse(apiSend<Project>(`/api/data/projects/${id}`, 'PUT', patch));

const deleteProject = (id: number) => apiSend<void>(`/api/data/projects/${id}`, 'DELETE');

const createTask = (projectId: number, input: CreateTaskInput) =>
  requiredResponse(apiSend<Task>(`/api/data/projects/${projectId}/tasks`, 'POST', input));

const fetchTask = (id: number) => apiGet<Task>(`/api/data/tasks/${id}`);

const updateTask = (id: number, patch: UpdateTaskInput | TaskPatch) =>
  requiredResponse(apiSend<Task>(`/api/data/tasks/${id}`, 'PUT', patch));

const deleteTask = (id: number) => apiSend<void>(`/api/data/tasks/${id}`, 'DELETE');

export const api = {
  status: () => apiGet<ServiceStatus[]>('/api/status'),
  metrics: () => apiGet<SystemMetrics>('/api/metrics'),

  projects: listProjects,
  listProjects,
  getProjects: listProjects,
  project: fetchProject,
  getProject: fetchProject,
  createProject,
  updateProject,
  deleteProject,

  projectTasks: listProjectTasks,
  listTasks: listProjectTasks,
  tasks: listProjectTasks,
  getProjectTasks: listProjectTasks,
  getTasks: listProjectTasks,
  createTask,
  task: fetchTask,
  getTask: fetchTask,
  updateTask,
  deleteTask,
};
